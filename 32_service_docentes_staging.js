/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 32_service_docentes_staging.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Lógica de negocio para vincular docentes y asignaciones
 *   desde STG_DOCENTES / STG_ASIGNACIONES a las tablas maestras.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs        → SIDEP_CONFIG, constantes globales
 *   02_SIDEP_HELPERS.gs       → getSpreadsheetByName(), uuid(), nowSIDEP(), _leerHoja_()
 *   24b_repo_staging_academico.gs → registrarStgDocentesLog()
 *
 * PRINCIPIO:
 *   Lee datos de STG_* ya validados y aprobados (ApprovalStatus = APPROVED,
 *   StageStatus = VALIDATED). Promueve a Teachers y TeacherAssignments en maestras.
 *   Devuelve resúmenes de operación — nunca escribe al log directamente.
 *
 * ALGORITMO DE PROMOCIÓN:
 *   DOCENTES   → INSERT si email nuevo, UPDATE si ya existe en Teachers.
 *   ASIGNACIONES → crea invitación Classroom vía Invitations.create()
 *                   y escribe en TeacherAssignments.
 *   El docente debe ACEPTAR la invitación por email.
 *   Re-ejecutar es idempotente: 409 = ya invitado.
 * ============================================================
 */


// ── Constantes del servicio ───────────────────────────────────

const CONTRATOS_VALIDOS_STG = ["PLANTA", "CONTRATISTA", "HORA_CATEDRA"];
const TIPOS_DOC_VALIDOS_STG = ["CC", "CE", "PA", "NIT", "OTRO"];

const COLS_REQUERIDAS_TEACHERS_STG = [
  "TeacherID", "FirstName", "LastName", "Email", "Phone",
  "DocumentType", "DocumentNumber", "CampusCode", "TeacherStatusCode",
  "HireDate", "Notes", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy"
];

const COLS_REQUERIDAS_ASSIGNMENTS_STG = [
  "AssignmentID", "TeacherID", "DeploymentID", "CampusCode",
  "WeeklyHours", "StartDate", "EndDate", "ContractTypeCode",
  "IsActive", "CreatedAt", "CreatedBy",
  "InvitationID", "InvitationStatus"
];


// ════════════════════════════════════════════════════════════
// PUNTO DE ENTRADA — llamado desde 42_job_procesarStgDocentes
// ════════════════════════════════════════════════════════════

/**
 * Procesa filas aprobadas de STG_DOCENTES y STG_ASIGNACIONES.
 * Lee los datos de staging desde el repo, ejecuta la promoción y
 * retorna un resumen de resultados.
 *
 * @param {object} opts
 * @param {Array}  opts.docentesRows    — filas de STG_DOCENTES (datos planos)
 * @param {object} opts.docentesIdx     — índice de columnas de STG_DOCENTES
 * @param {Array}  opts.asignacionesRows — filas de STG_ASIGNACIONES (datos planos)
 * @param {object} opts.asignacionesIdx  — índice de columnas de STG_ASIGNACIONES
 * @param {string} opts.ahora           — timestamp Bogotá
 * @param {string} opts.usuario         — email del ejecutor
 * @returns {{ teachersInsertados, teachersActualizados, invitacionesOk,
 *             invitacionesYaExistian, asignacionesEscritas, erroresClassroom,
 *             aulasOmitidas, docentesPromovidos, asignacionesPromovidas,
 *             errores: string[] }}
 */
function procesarDocentesDesdeStaging(opts) {
  const ahora   = opts.ahora   || nowSIDEP();
  const usuario = opts.usuario || Session.getEffectiveUser().getEmail();

  const coreSS  = getSpreadsheetByName("core");
  const adminSS = getSpreadsheetByName("admin");

  // Lectura maestras
  const memTeachers = _leerHojaCompletaSrv_(coreSS,  "Teachers");
  const memDepl     = _leerHojaCompletaSrv_(coreSS,  "MasterDeployments");
  const memAsig     = _leerHojaCompletaSrv_(adminSS, "TeacherAssignments");

  _verificarColumnasSrv_(memTeachers, COLS_REQUERIDAS_TEACHERS_STG);
  _verificarColumnasSrv_(memAsig,     COLS_REQUERIDAS_ASSIGNMENTS_STG);

  // Construir arrays planos tipo DOCENTES_DATA y ASIGNACIONES_DATA
  const docentesArr    = _stgRowsToDocentesArray_(opts.docentesRows,    opts.docentesIdx);
  const asignacionesArr = _stgRowsToAsignacionesArray_(opts.asignacionesRows, opts.asignacionesIdx);

  const planTeachers = _planificarTeachersSrv_(memTeachers, docentesArr, ahora, usuario);
  const emailToId    = _construirEmailTeacherIdxSrv_(memTeachers);
  const deplIdx      = _indexarDeploymentsSrv_(memDepl);
  const asigExist    = _indexarAsignacionesExistentesSrv_(memAsig);
  const planAsig     = _planificarAsignacionesSrv_(emailToId, deplIdx, asigExist,
                                                    docentesArr, asignacionesArr, ahora, usuario);

  _escribirTeachersSrv_(memTeachers, planTeachers);
  const resAsig = _ejecutarAsignacionesSrv_(memAsig, planAsig);

  _registrarLogMaestra_(adminSS,
    resAsig.errores > 0 ? "PARTIAL" : "SUCCESS",
    planTeachers.inserts.length + planTeachers.updates.length + resAsig.escritas,
    resAsig.errores > 0 ? resAsig.errores + " asignaciones fallaron en Classroom" : "",
    ahora, usuario
  );

  return {
    teachersInsertados:       planTeachers.inserts.length,
    teachersActualizados:     planTeachers.updates.length,
    invitacionesOk:           resAsig.classroomOk,
    invitacionesYaExistian:   resAsig.yaExistia,
    asignacionesEscritas:     resAsig.escritas,
    erroresClassroom:         resAsig.errores,
    aulasOmitidas:            planAsig.omitidas,
    docentesPromovidos:       planTeachers.inserts.concat(planTeachers.updates).map(function(p) {
      return p.email;
    }),
    asignacionesPromovidas:   resAsig.promovidas,
    errores:                  resAsig.mensajesError
  };
}


// ── Adaptadores staging → arrays planos ──────────────────────

/**
 * Convierte filas de STG_DOCENTES al formato interno del servicio.
 * [FirstName, LastName, Email, Phone, DocumentType, DocumentNumber,
 *  HireDate, ContractType, Notes]
 */
function _stgRowsToDocentesArray_(rows, idx) {
  return (rows || []).map(function(row) {
    return [
      String(row[idx["FirstName"]]      || "").trim(),
      String(row[idx["LastName"]]       || "").trim(),
      String(row[idx["Email"]]          || "").trim(),
      String(row[idx["Phone"]]          || "").trim(),
      String(row[idx["DocumentType"]]   || "").trim(),
      String(row[idx["DocumentNumber"]] || "").trim(),
      row[idx["HireDate"]]   || "",
      String(row[idx["ContractType"]]   || "").trim(),
      String(row[idx["Notes"]]          || "").trim()
    ];
  });
}

/**
 * Convierte filas de STG_ASIGNACIONES al formato interno del servicio.
 * [Email, ProgramCode, SubjectCode, CohortCode, MomentCode,
 *  WeeklyHours, StartDate, EndDate]
 */
function _stgRowsToAsignacionesArray_(rows, idx) {
  return (rows || []).map(function(row) {
    return [
      String(row[idx["TeacherEmail"]]  || "").trim(),
      String(row[idx["ProgramCode"]]   || "").trim(),
      String(row[idx["SubjectCode"]]   || "").trim(),
      String(row[idx["CohortCode"]]    || "").trim(),
      String(row[idx["MomentCode"]]    || "").trim(),
      Number(row[idx["WeeklyHours"]]   || 0),
      row[idx["StartDate"]]            || "",
      row[idx["EndDate"]]              || ""
    ];
  });
}


// ── Validación ────────────────────────────────────────────────

/**
 * Valida filas de STG_DOCENTES antes de procesar.
 * Lanza Error descriptivo si hay problemas.
 * @param {Array[]} docentesArr — formato interno [nombre, apellido, email…]
 */
function validarDocentesStaging(docentesArr) {
  if (!docentesArr || docentesArr.length === 0) {
    throw new Error("validarDocentesStaging: sin filas APPROVED/VALIDATED.");
  }
  const emailsVistos = {};
  docentesArr.forEach(function(d, i) {
    const ctx   = "STG_DOCENTES[" + i + "] (" + (d[2] || "sin email") + ")";
    const email = d[2];

    if (!d[0] || !d[1]) throw new Error(ctx + ": FirstName o LastName vacío.");
    if (!email)          throw new Error(ctx + ": Email vacío.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(ctx + ": formato de email inválido.");
    }
    if (emailsVistos[email.toLowerCase()]) {
      throw new Error(ctx + ": email duplicado en el lote.");
    }
    emailsVistos[email.toLowerCase()] = true;

    if (!d[7] || CONTRATOS_VALIDOS_STG.indexOf(d[7]) === -1) {
      throw new Error(ctx + ": ContractType inválido → '" + d[7] + "'. " +
                      "Valores: " + CONTRATOS_VALIDOS_STG.join(", "));
    }
    if (d[4] && TIPOS_DOC_VALIDOS_STG.indexOf(d[4]) === -1) {
      throw new Error(ctx + ": DocumentType inválido → '" + d[4] + "'.");
    }
    if (d[6] && _parseFechaSrv_(d[6]) === "") {
      throw new Error(ctx + ": HireDate inválida → '" + d[6] + "' (usar yyyy-MM-dd).");
    }
  });
}

/**
 * Valida filas de STG_ASIGNACIONES antes de procesar.
 * @param {Array[]} asignacionesArr
 */
function validarAsignacionesStaging(asignacionesArr) {
  if (!asignacionesArr || asignacionesArr.length === 0) return;
  asignacionesArr.forEach(function(a, i) {
    const ctx = "STG_ASIGNACIONES[" + i + "] (" + (a[0] || "sin email") + ")";
    if (!a[0])                               throw new Error(ctx + ": TeacherEmail vacío.");
    if (!a[1] || TODOS_LOS_PROGRAMAS.indexOf(a[1]) === -1) {
      throw new Error(ctx + ": ProgramCode inválido → '" + a[1] + "'.");
    }
    if (!a[2]) throw new Error(ctx + ": SubjectCode vacío.");
    if (!a[3]) throw new Error(ctx + ": CohortCode vacío.");
    if (!a[4] || MOMENT_ORDER[a[4]] === undefined) {
      throw new Error(ctx + ": MomentCode inválido → '" + a[4] + "'.");
    }
    if (!a[5] || isNaN(a[5]) || Number(a[5]) < 1) {
      throw new Error(ctx + ": WeeklyHours inválidas → '" + a[5] + "'.");
    }
    const fIni = a[6] ? _parseFechaSrv_(a[6]) : "";
    const fFin = a[7] ? _parseFechaSrv_(a[7]) : "";
    if (a[6] && fIni === "") throw new Error(ctx + ": StartDate inválida → '" + a[6] + "'.");
    if (a[7] && fFin === "") throw new Error(ctx + ": EndDate inválida → '" + a[7] + "'.");
    if (fIni !== "" && fFin !== "" && fFin < fIni) {
      throw new Error(ctx + ": EndDate (" + a[7] + ") anterior a StartDate (" + a[6] + ").");
    }
  });
}


// ── Lectura de maestras ───────────────────────────────────────

function _leerHojaCompletaSrv_(ss, nombreHoja) {
  const hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) {
    throw new Error(
      "Hoja '" + nombreHoja + "' no encontrada en '" + ss.getName() + "'. " +
      "¿Ejecutaste setupSidepTables()?"
    );
  }
  const lastRow = hoja.getLastRow();
  const lastCol = hoja.getLastColumn();
  if (lastRow === 0 || lastCol === 0) {
    return { hoja: hoja, nombreHoja: nombreHoja, encabezado: [], datos: [], colIdx: {}, datosOriginalesCount: 0 };
  }
  const todo       = hoja.getRange(1, 1, lastRow, lastCol).getValues();
  const encabezado = todo[0];
  let datos        = lastRow > 1 ? todo.slice(1) : [];
  datos = datos.filter(function(fila) { return fila.some(function(c) { return c !== ""; }); });
  const colIdx = {};
  encabezado.forEach(function(nombre, i) { if (nombre !== "") colIdx[String(nombre)] = i; });
  return { hoja: hoja, nombreHoja: nombreHoja, encabezado: encabezado, datos: datos, colIdx: colIdx, datosOriginalesCount: datos.length };
}

function _verificarColumnasSrv_(mem, colsRequeridas) {
  const faltantes = colsRequeridas.filter(function(col) {
    return mem.colIdx[col] === undefined;
  });
  if (faltantes.length > 0) {
    throw new Error(
      "Columnas faltantes en '" + mem.nombreHoja + "': " + faltantes.join(", ")
    );
  }
}


// ── Planificación ─────────────────────────────────────────────

function _planificarTeachersSrv_(mem, docentesArr, ahora, usuario) {
  const inserts  = [];
  const updates  = [];
  const emailIdx = {};

  mem.datos.forEach(function(fila, i) {
    const email = String(fila[mem.colIdx["Email"]] || "").toLowerCase().trim();
    if (email) emailIdx[email] = i;
  });

  docentesArr.forEach(function(d) {
    const email    = d[2].toLowerCase().trim();
    const hireDate = _parseFechaSrv_(d[6]);

    if (emailIdx.hasOwnProperty(email)) {
      const i = emailIdx[email];
      const c = mem.colIdx;
      mem.datos[i][c["FirstName"]]      = d[0];
      mem.datos[i][c["LastName"]]       = d[1];
      mem.datos[i][c["Phone"]]          = d[3];
      mem.datos[i][c["DocumentType"]]   = d[4];
      mem.datos[i][c["DocumentNumber"]] = d[5];
      mem.datos[i][c["HireDate"]]       = hireDate;
      mem.datos[i][c["Notes"]]          = d[8];
      mem.datos[i][c["UpdatedAt"]]      = ahora;
      mem.datos[i][c["UpdatedBy"]]      = usuario;
      updates.push({ filaIdx: i, email: d[2] });
    } else {
      const newId     = uuid("tch");
      const c         = mem.colIdx;
      const nuevaFila = new Array(mem.encabezado.length).fill("");
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
      mem.datos.push(nuevaFila);
    }
  });

  return { inserts: inserts, updates: updates };
}

function _construirEmailTeacherIdxSrv_(mem) {
  const idx = {};
  mem.datos.forEach(function(fila) {
    const email = String(fila[mem.colIdx["Email"]]     || "").toLowerCase().trim();
    const id    = String(fila[mem.colIdx["TeacherID"]] || "").trim();
    if (email && id) idx[email] = id;
  });
  return idx;
}

function _indexarDeploymentsSrv_(mem) {
  const idCol  = mem.colIdx["DeploymentID"];
  const nomCol = mem.colIdx["GeneratedNomenclature"];
  const cidCol = mem.colIdx["ClassroomID"];
  const stCol  = mem.colIdx["ScriptStatusCode"];
  if ([idCol, nomCol, cidCol, stCol].some(function(c) { return c === undefined; })) {
    throw new Error("MasterDeployments: columnas requeridas faltantes.");
  }
  const idx = {};
  mem.datos.forEach(function(fila) {
    const nom    = String(fila[nomCol] || "").trim();
    const id     = String(fila[idCol]  || "").trim();
    const cid    = String(fila[cidCol] || "").trim();
    const status = String(fila[stCol]  || "").trim();
    if (!nom || !id) return;
    const segs = nom.split("-");
    if (segs.length >= 5) {
      idx[segs[0] + "-" + segs[2] + "-" + segs[3] + "-" + segs[4]] =
        { id: id, classroomId: cid, status: status };
    }
  });
  return idx;
}

function _indexarAsignacionesExistentesSrv_(mem) {
  const idx    = {};
  const tchCol = mem.colIdx["TeacherID"];
  const depCol = mem.colIdx["DeploymentID"];
  if (tchCol === undefined || depCol === undefined) return idx;
  mem.datos.forEach(function(fila) {
    const t = String(fila[tchCol] || "").trim();
    const d = String(fila[depCol] || "").trim();
    if (t && d) idx[t + "_" + d] = true;
  });
  return idx;
}

function _planificarAsignacionesSrv_(emailToId, deplIdx, asigExist, docentesArr, asignacionesArr, ahora, usuario) {
  const porCrear   = [];
  let   duplicadas = 0;
  let   omitidas   = 0;

  const emailAContrato = {};
  docentesArr.forEach(function(d) {
    emailAContrato[d[2].toLowerCase().trim()] = d[7];
  });

  asignacionesArr.forEach(function(a) {
    const email   = a[0].toLowerCase().trim();
    const prog    = a[1], cod = a[2], cohorte = a[3], mom = a[4];

    const teacherId = emailToId[email];
    if (!teacherId) { omitidas++; return; }

    const deplKey = prog + "-" + cohorte + "-" + mom + "-" + cod;
    const depl    = deplIdx[deplKey];

    if (!depl || depl.status !== "CREATED") { omitidas++; return; }

    const asigKey = teacherId + "_" + depl.id;
    if (asigExist[asigKey]) { duplicadas++; return; }

    porCrear.push({
      email:       a[0],
      teacherId:   teacherId,
      deplId:      depl.id,
      classroomId: depl.classroomId,
      logKey:      prog + "-" + cod + " [" + cohorte + " " + mom + "]",
      filaBase: [
        uuid("asg"),
        teacherId,
        depl.id,
        SIDEP_CONFIG.defaultCampus,
        a[5],
        _parseFechaSrv_(a[6]),
        _parseFechaSrv_(a[7]),
        emailAContrato[email] || "",
        false,
        ahora,
        usuario
      ]
    });
  });

  return { porCrear: porCrear, duplicadas: duplicadas, omitidas: omitidas };
}


// ── Escritura en maestras ─────────────────────────────────────

function _escribirTeachersSrv_(mem, plan) {
  const hoja = mem.hoja;
  if (plan.updates.length > 0 && mem.datosOriginalesCount > 0) {
    hoja.getRange(2, 1, mem.datosOriginalesCount, mem.encabezado.length)
        .setValues(mem.datos.slice(0, mem.datosOriginalesCount));
  }
  if (plan.inserts.length > 0) {
    const ultima = hoja.getLastRow();
    hoja.getRange(ultima + 1, 1, plan.inserts.length, plan.inserts[0].length)
        .setValues(plan.inserts);
  }
}

function _ejecutarAsignacionesSrv_(memAsig, plan) {
  const conteo        = { classroomOk: 0, yaExistia: 0, escritas: 0, errores: 0 };
  const filasAprobadas = [];
  const promovidas     = [];
  const mensajesError  = [];

  plan.porCrear.forEach(function(asig) {
    const resultado = _invitarCoTeacherConRetrySrv_(asig.classroomId, asig.email, asig.logKey);
    if (resultado.estado === "ERROR") {
      conteo.errores++;
      mensajesError.push("ERROR Classroom: " + asig.email + " → " + asig.logKey);
      return;
    }
    if (resultado.estado === "YA_EXISTIA") conteo.yaExistia++;
    else conteo.classroomOk++;

    filasAprobadas.push(asig.filaBase.concat([resultado.invitationId, "TEACHER_INVITED"]));
    promovidas.push(asig.email + "→" + asig.logKey);
  });

  if (filasAprobadas.length > 0) {
    const hoja   = memAsig.hoja;
    const ultima = hoja.getLastRow();
    try {
      hoja.getRange(ultima + 1, 1, filasAprobadas.length, filasAprobadas[0].length)
          .setValues(filasAprobadas);
      conteo.escritas = filasAprobadas.length;
    } catch (e) {
      throw new Error(
        "ESCRITURA PARCIAL: Classroom invitaciones enviadas [" +
        promovidas.join(" | ") +
        "] pero setValues falló: " + e.message +
        ". Re-ejecutar (409 es idempotente)."
      );
    }
  }

  conteo.promovidas    = promovidas;
  conteo.mensajesError = mensajesError;
  return conteo;
}


// ── Classroom API — Invitaciones con retry y backoff ─────────

/**
 * Envía invitación de co-teacher vía Classroom.Invitations.create().
 * 3 intentos. Backoff: 5s → 10s → 20s.
 * Solo reintenta en 429. 409 = YA_EXISTIA. 403 = ERROR inmediato.
 *
 * @returns {{ estado: "OK"|"YA_EXISTIA"|"ERROR", invitationId: string }}
 */
function _invitarCoTeacherConRetrySrv_(classroomId, email, logKey) {
  const esperas = [5000, 10000, 20000];
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const inv = Classroom.Invitations.create({
        courseId: classroomId,
        userId:   email,
        role:     "TEACHER"
      });
      Logger.log("  ✉️  Invitación: " + email + " → " + logKey + " (id:" + inv.id + ")");
      return { estado: "OK", invitationId: inv.id };
    } catch (e) {
      const msg = e.message || String(e);

      if (msg.indexOf("409") !== -1 || msg.toLowerCase().indexOf("already") !== -1) {
        Logger.log("  ℹ️  Ya existe: " + email + " → " + logKey);
        return { estado: "YA_EXISTIA", invitationId: "" };
      }
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
      if (msg.indexOf("403") !== -1 || msg.toLowerCase().indexOf("permission") !== -1) {
        Logger.log("  ⛔ 403 sin permiso: " + email + " → " + logKey);
        return { estado: "ERROR", invitationId: "" };
      }
      Logger.log("  ⚠️  Intento " + intento + "/3 [" + logKey + "]: " + msg);
      if (intento < 3) Utilities.sleep(esperas[intento - 1]);
    }
  }
  Logger.log("  ⛔ Fallaron todos los intentos: " + email + " → " + logKey);
  return { estado: "ERROR", invitationId: "" };
}


// ── Helpers privados ─────────────────────────────────────────

/**
 * Convierte "yyyy-MM-dd" a Date en timezone Bogotá.
 * Retorna "" si la cadena es vacía o inválida.
 */
function _parseFechaSrv_(fechaStr) {
  if (!fechaStr) return "";
  try {
    const d = Utilities.parseDate(
      String(fechaStr).trim(),
      SIDEP_CONFIG.timezone,
      "yyyy-MM-dd"
    );
    return isNaN(d.getTime()) ? "" : d;
  } catch (e) {
    return "";
  }
}

function _registrarLogMaestra_(adminSS, resultado, registros, errorMsg, ahora, usuario) {
  try {
    const hoja = adminSS.getSheetByName("AutomationLogs");
    if (!hoja) return;
    hoja.appendRow([
      uuid("log"), "SHEETS", "IMPORT_TEACHERS", "procesarStgDocentes",
      resultado, registros, errorMsg || "",
      ahora, usuario
    ]);
  } catch (e) {
    Logger.log("⚠️  No se pudo escribir AutomationLog: " + e.message);
  }
}
