/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 18b_notificarEstudiantes.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Enviar un email personalizado a cada estudiante con su programa,
 *   cohorte de ingreso, ventana activa, asignaturas, horarios,
 *   docentes y los links para unirse a sus aulas de Classroom.
 *
 * CUÁNDO SE EJECUTA:
 *   Automáticamente al final de procesarStgMatriculas() para las
 *   matrículas recién creadas (EnrollmentStatusCode=ACTIVE).
 *   También disponible en el menú para reenvíos.
 *
 * DIFERENCIA VS notificarDocentes():
 *   Estudiantes usan cuentas @gmail.com — NO pueden ser invitados
 *   directamente por API al dominio. Se usa enrollmentCode:
 *   el estudiante sigue el link ?cjc=CODE para unirse al aula.
 *
 * FUENTE DE DATOS (todo desde Sheets — sin llamadas a Classroom API extra):
 *   Students           → email, nombre, CohortCode (entrada), ProgramCode
 *   Enrollments        → DeploymentID, WindowCohortCode, MomentCode
 *   MasterDeployments  → ClassroomID, GeneratedClassroomName, SubjectCode
 *                        (enrollmentCode se obtiene via Classroom.Courses.get())
 *   TeacherAssignments → DayOfWeek, StartTime, EndTime, WeeklyHours, TeacherID
 *   Teachers           → FirstName, LastName (nombre del docente)
 *   _CFG_PROGRAMS      → ProgramName (nombre completo del programa)
 *   _CFG_SUBJECTS      → SubjectName (nombre completo de la asignatura)
 *
 * FUNCIONES PÚBLICAS:
 *   notificarEstudiantes()                 → envía a estudiantes con matrículas ACTIVE
 *   notificarEstudiantes({ dryRun:true })  → preview en Logger sin enviar
 *   notificarEstudiante_individual(email)  → reenvío a un estudiante específico
 * ============================================================
 */


var NOTIF_EST_REMITENTE = "SIDEP Ecosistema Digital";
var NOTIF_EST_ASUNTO    = "Bienvenido a SIDEP \u2014 tus aulas y horario";

var DIAS_LABEL_EST = {
  "LUNES":     "Lunes",
  "MARTES":    "Martes",
  "MIERCOLES": "Miercoles",
  "JUEVES":    "Jueves",
  "VIERNES":   "Viernes",
  "SABADO":    "Sabado"
};


// ── Función principal ─────────────────────────────────────────

/**
 * Envía email a cada estudiante con matrículas ACTIVE informando
 * su programa, cohorte, asignaturas, horarios, docentes y links.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun]    — preview sin enviar
 * @param {string}  [opts.soloEmail] — enviar solo a este estudiante
 */
function notificarEstudiantes(opts) {
  var options   = opts || {};
  var dryRun    = options.dryRun    === true;
  var soloEmail = options.soloEmail ? options.soloEmail.toLowerCase().trim() : null;
  var ahora     = nowSIDEP();
  var ejecutor  = Session.getEffectiveUser().getEmail();
  var inicio    = Date.now();
  var conteo    = { enviados: 0, omitidos: 0, errores: 0, sinAulas: 0 };

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — notificarEstudiantes v1.0" + (dryRun ? " [DRY RUN]" : ""));
  Logger.log("   Ejecutor : " + ejecutor);
  if (soloEmail) Logger.log("   Filtro   : " + soloEmail);
  Logger.log("════════════════════════════════════════════════");

  var adminSS, logResult = "ERROR", logMsg = "";

  try {
    var coreSS = getSpreadsheetByName("core");
    adminSS    = getSpreadsheetByName("admin");

    // ── PASO 1: Leer tablas en memoria ────────────────────────
    Logger.log("\n-- Leyendo tablas en memoria --");
    var memStu   = _leerHojaNotifEst_(adminSS, "Students");
    var memEnr   = _leerHojaNotifEst_(adminSS, "Enrollments");
    var memDepl  = _leerHojaNotifEst_(coreSS,  "MasterDeployments");
    var memAsig  = _leerHojaNotifEst_(adminSS, "TeacherAssignments");
    var memTch   = _leerHojaNotifEst_(coreSS,  "Teachers");
    var memProg  = _leerHojaNotifEst_(coreSS,  "_CFG_PROGRAMS");
    var memSubj  = _leerHojaNotifEst_(coreSS,  "_CFG_SUBJECTS");

    Logger.log("  Students          : " + memStu.datos.length);
    Logger.log("  Enrollments       : " + memEnr.datos.length);
    Logger.log("  MasterDeployments : " + memDepl.datos.length);
    Logger.log("  TeacherAssignments: " + memAsig.datos.length);
    Logger.log("  Teachers          : " + memTch.datos.length);
    Logger.log("  _CFG_PROGRAMS     : " + memProg.datos.length);
    Logger.log("  _CFG_SUBJECTS     : " + memSubj.datos.length);

    // ── PASO 2: Índices ───────────────────────────────────────
    var stuIdx   = _indexarStudents_(memStu);           // studentId → { email, firstName, lastName, cohortCode, programCode }
    var deplIdx  = _indexarDeplNotifEst_(memDepl);      // deploymentId → { classroomId, nombre, subjectCode, cohortCode, momentCode }
    var asigIdx  = _indexarAsigPorDepl_(memAsig, memTch); // deploymentId → { teacherName, dayOfWeek, startTime, endTime, weeklyHours }
    var progIdx  = _indexarProgramas_(memProg);         // programCode → programName
    var subjIdx  = _indexarAsignaturas_(memSubj);       // subjectCode → subjectName

    // ── PASO 3: Obtener enrollmentCodes de Classroom API ─────
    // Solo para aulas con matrículas ACTIVE — reducir llamadas API
    var classroomIds = _recopilarClassroomIds_(memEnr, deplIdx);
    var enrollCodes  = _obtenerEnrollmentCodes_(classroomIds, dryRun);
    Logger.log("  enrollmentCodes obtenidos: " + Object.keys(enrollCodes).length);

    // ── PASO 4: Agrupar matrículas por estudiante ─────────────
    var porEstudiante = _agruparPorEstudiante_(memEnr, stuIdx, deplIdx, asigIdx,
                                               progIdx, subjIdx, enrollCodes);
    Logger.log("  Estudiantes con matriculas ACTIVE: " +
               Object.keys(porEstudiante).length);

    // ── PASO 5: Enviar emails ─────────────────────────────────
    Logger.log("\n-- " + (dryRun ? "Preview (DRY RUN)" : "Enviando emails") + " --");

    Object.keys(porEstudiante).forEach(function(email) {
      if (soloEmail && email !== soloEmail) return;

      var info = porEstudiante[email];

      if (info.aulas.length === 0) {
        Logger.log("  Sin aulas: " + email);
        conteo.sinAulas++;
        return;
      }

      var cuerpo = _construirEmailEstudiante_(info);

      if (dryRun) {
        Logger.log("\n  [DRY RUN] Para: " + email);
        Logger.log("     Nombre   : " + info.firstName + " " + info.lastName);
        Logger.log("     Programa : " + info.programName + " (" + info.programCode + ")");
        Logger.log("     Cohorte  : " + info.entryCohortCode + " (ventana: " + info.windowCohortCode + ")");
        Logger.log("     Aulas    : " + info.aulas.length);
        info.aulas.forEach(function(a) {
          Logger.log("       · " + a.subjectName + " | " + a.teacherName +
                     " | " + (DIAS_LABEL_EST[a.dayOfWeek] || a.dayOfWeek) +
                     " " + a.startTime + "-" + a.endTime +
                     " | link: " + (a.enrollLink || "(sin enrollCode)"));
        });
        conteo.enviados++;
        return;
      }

      try {
        GmailApp.sendEmail(email, NOTIF_EST_ASUNTO, "", {
          name     : NOTIF_EST_REMITENTE,
          htmlBody : cuerpo,
          replyTo  : ejecutor
        });
        Logger.log("  OK Enviado: " + email + " (" + info.aulas.length + " aulas)");
        conteo.enviados++;
      } catch (eEmail) {
        Logger.log("  ERROR enviando a " + email + ": " + eEmail.message);
        conteo.errores++;
      }
    });

    // ── Resumen ───────────────────────────────────────────────
    var dur = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log("\n════════════════════════════════════════════════");
    Logger.log((dryRun ? "DRY RUN" : "OK Notificaciones") + " completadas en " + dur + "s");
    Logger.log("  Emails " + (dryRun ? "simulados" : "enviados") + " : " + conteo.enviados);
    Logger.log("  Sin aulas : " + conteo.sinAulas);
    Logger.log("  Errores   : " + conteo.errores);
    Logger.log("════════════════════════════════════════════════");

    logResult = conteo.errores > 0 ? "PARTIAL" : "SUCCESS";
    logMsg    = conteo.errores > 0 ? conteo.errores + " email(s) fallaron" : "";

  } catch (e) {
    logResult = "ERROR";
    logMsg    = e.message || String(e);
    Logger.log("ERROR: " + logMsg);
    throw e;

  } finally {
    if (adminSS && !dryRun) {
      try {
        var logHoja = adminSS.getSheetByName("AutomationLogs");
        if (logHoja) {
          logHoja.appendRow([
            uuid("log"), "GMAIL", "NOTIFY_STUDENTS", "notificarEstudiantes",
            logResult, conteo.enviados, logMsg || "",
            nowSIDEP(), Session.getEffectiveUser().getEmail()
          ]);
        }
      } catch (eLog) {
        Logger.log("Aviso: No se pudo escribir AutomationLog: " + eLog.message);
      }
    }
  }
}

function notificarEstudiantes_dryRun() {
  notificarEstudiantes({ dryRun: true });
}

function notificarEstudiante_individual(email) {
  if (!email) {
    Logger.log("Especifica el email: notificarEstudiante_individual('email@gmail.com')");
    return;
  }
  notificarEstudiantes({ soloEmail: email });
}


// ── Helpers de lectura ────────────────────────────────────────

function _leerHojaNotifEst_(ss, nombreHoja) {
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) throw new Error("Hoja '" + nombreHoja + "' no encontrada en '" + ss.getName() + "'.");
  var lastRow = hoja.getLastRow();
  var lastCol = hoja.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return { hoja: hoja, encabezado: [], datos: [], colIdx: {} };
  var encabezado = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIdx = {};
  encabezado.forEach(function(n, i) { if (n !== "") colIdx[String(n)] = i; });
  var datos = lastRow > 1
    ? hoja.getRange(2, 1, lastRow - 1, lastCol).getValues()
          .filter(function(f) { return f.some(function(c) { return c !== ""; }); })
    : [];
  return { hoja: hoja, encabezado: encabezado, datos: datos, colIdx: colIdx };
}


// ── Helpers de indexación ─────────────────────────────────────

/** studentId → { email, firstName, lastName, cohortCode, programCode } */
function _indexarStudents_(mem) {
  var idx = {};
  var c   = mem.colIdx;
  mem.datos.forEach(function(f) {
    var id = String(f[c["StudentID"]] || "").trim();
    if (!id) return;
    idx[id] = {
      email          : String(f[c["Email"]]      || "").toLowerCase().trim(),
      firstName      : String(f[c["FirstName"]]  || "").trim(),
      lastName       : String(f[c["LastName"]]   || "").trim(),
      cohortCode     : String(f[c["CohortCode"]] || "").trim(),
      programCode    : String(f[c["ProgramCode"]]|| "").trim(),
      studentStatus  : String(f[c["StudentStatusCode"]] || "").trim()
    };
  });
  return idx;
}

/** deploymentId → { classroomId, nombre, subjectCode, windowCohortCode, momentCode } */
function _indexarDeplNotifEst_(mem) {
  var idx = {};
  var c   = mem.colIdx;
  mem.datos.forEach(function(f) {
    var id  = String(f[c["DeploymentID"]]           || "").trim();
    var cid = String(f[c["ClassroomID"]]            || "").trim();
    var nom = String(f[c["GeneratedClassroomName"]] || "").trim();
    var sub = String(f[c["SubjectCode"]]            || "").trim();
    var coh = String(f[c["CohortCode"]]             || "").trim();
    var mom = String(f[c["MomentCode"]]             || "").trim();
    if (id) idx[id] = { classroomId: cid, nombre: nom, subjectCode: sub,
                        windowCohortCode: coh, momentCode: mom };
  });
  return idx;
}

/** deploymentId → { teacherName, dayOfWeek, startTime, endTime, weeklyHours } */
function _indexarAsigPorDepl_(memAsig, memTch) {
  var idx   = {};
  var ca    = memAsig.colIdx;
  var ct    = memTch.colIdx;

  // Índice teacherId → { firstName, lastName }
  var tchNombres = {};
  memTch.datos.forEach(function(f) {
    var id = String(f[ct["TeacherID"]] || "").trim();
    if (id) tchNombres[id] = {
      firstName: String(f[ct["FirstName"]] || "").trim(),
      lastName:  String(f[ct["LastName"]]  || "").trim()
    };
  });

  memAsig.datos.forEach(function(f) {
    var deplId   = String(f[ca["DeploymentID"]] || "").trim();
    var tchId    = String(f[ca["TeacherID"]]    || "").trim();
    var isActive = f[ca["IsActive"]];

    if (!deplId) return;
    // Tomar solo asignaciones activas; si hay varias, la primera activa gana
    if (idx[deplId] && !isActive) return;
    if (!isActive && idx[deplId]) return;

    var tch = tchNombres[tchId] || { firstName: "", lastName: "" };
    idx[deplId] = {
      teacherName : tch.firstName + " " + tch.lastName,
      dayOfWeek   : String(f[ca["DayOfWeek"]]  || "").trim(),
      startTime   : _formatearTiempoNotifEst_(f[ca["StartTime"]]),
      endTime     : _formatearTiempoNotifEst_(f[ca["EndTime"]]),
      weeklyHours : Number(f[ca["WeeklyHours"]] || 0)
    };
  });

  return idx;
}

/** programCode → programName */
function _indexarProgramas_(mem) {
  var idx = {};
  var c   = mem.colIdx;
  mem.datos.forEach(function(f) {
    var code = String(f[c["ProgramCode"]] || "").trim();
    var name = String(f[c["ProgramName"]] || "").trim();
    if (code) idx[code] = name;
  });
  return idx;
}

/** subjectCode → subjectName */
function _indexarAsignaturas_(mem) {
  var idx = {};
  var c   = mem.colIdx;
  mem.datos.forEach(function(f) {
    var code = String(f[c["SubjectCode"]] || "").trim();
    var name = String(f[c["SubjectName"]] || "").trim();
    if (code) idx[code] = name;
  });
  return idx;
}

/** Recopila los ClassroomIDs únicos de los deployments con matrículas ACTIVE */
function _recopilarClassroomIds_(memEnr, deplIdx) {
  var ids = {};
  var c   = memEnr.colIdx;
  memEnr.datos.forEach(function(f) {
    var deplId = String(f[c["DeploymentID"]]        || "").trim();
    var status = String(f[c["EnrollmentStatusCode"]] || "").trim();
    if (status !== "ACTIVE") return;
    var depl = deplIdx[deplId];
    if (depl && depl.classroomId) ids[depl.classroomId] = true;
  });
  return Object.keys(ids);
}

/**
 * Llama Classroom.Courses.get(id) para obtener enrollmentCode.
 * En dryRun también lo hace — es solo lectura y no tiene costo operacional alto.
 * @returns {{ classroomId → enrollmentCode }}
 */
function _obtenerEnrollmentCodes_(classroomIds, dryRun) {
  var codes = {};
  classroomIds.forEach(function(cid) {
    try {
      var curso = Classroom.Courses.get(cid);
      if (curso && curso.enrollmentCode) {
        codes[cid] = curso.enrollmentCode;
      }
    } catch (e) {
      Logger.log("  Aviso: No se pudo obtener enrollmentCode para " + cid + ": " + e.message);
    }
  });
  return codes;
}

/**
 * Agrupa matrículas ACTIVE por email de estudiante.
 * @returns {{ email → { firstName, lastName, programCode, programName,
 *                        entryCohortCode, windowCohortCode,
 *                        aulas: [{subjectCode, subjectName, teacherName,
 *                                 dayOfWeek, startTime, endTime, weeklyHours,
 *                                 classroomId, enrollLink, nombre}] } }}
 */
function _agruparPorEstudiante_(memEnr, stuIdx, deplIdx, asigIdx,
                                 progIdx, subjIdx, enrollCodes) {
  var grupos = {};
  var c      = memEnr.colIdx;

  memEnr.datos.forEach(function(f) {
    var status  = String(f[c["EnrollmentStatusCode"]] || "").trim();
    if (status !== "ACTIVE") return;

    var stuId  = String(f[c["StudentID"]]    || "").trim();
    var deplId = String(f[c["DeploymentID"]] || "").trim();
    var stu    = stuIdx[stuId];
    var depl   = deplIdx[deplId];

    if (!stu || !stu.email || !depl || !depl.classroomId) return;

    var asig        = asigIdx[deplId] || { teacherName: "", dayOfWeek: "",
                                            startTime: "", endTime: "", weeklyHours: 0 };
    var enrollCode  = enrollCodes[depl.classroomId] || "";
    var enrollLink  = enrollCode
      ? "https://classroom.google.com/c/" + depl.classroomId + "?cjc=" + enrollCode
      : "https://classroom.google.com/c/" + depl.classroomId;

    if (!grupos[stu.email]) {
      var windowCoh = String(f[c["WindowCohortCode"]] || depl.windowCohortCode || "").trim();
      grupos[stu.email] = {
        firstName       : stu.firstName,
        lastName        : stu.lastName,
        programCode     : stu.programCode,
        programName     : progIdx[stu.programCode] || stu.programCode,
        entryCohortCode : stu.cohortCode,
        windowCohortCode: windowCoh,
        aulas           : []
      };
    }

    grupos[stu.email].aulas.push({
      subjectCode  : depl.subjectCode,
      subjectName  : subjIdx[depl.subjectCode] || depl.subjectCode,
      teacherName  : asig.teacherName,
      dayOfWeek    : asig.dayOfWeek,
      diaLabel     : DIAS_LABEL_EST[asig.dayOfWeek] || asig.dayOfWeek,
      startTime    : asig.startTime,
      endTime      : asig.endTime,
      weeklyHours  : asig.weeklyHours,
      classroomId  : depl.classroomId,
      enrollLink   : enrollLink,
      nombre       : depl.nombre
    });
  });

  // Ordenar aulas alfabéticamente por nombre de asignatura
  Object.keys(grupos).forEach(function(email) {
    grupos[email].aulas.sort(function(a, b) {
      return a.subjectName.localeCompare(b.subjectName);
    });
  });

  return grupos;
}


// ── Formateo de tiempo ────────────────────────────────────────

function _formatearTiempoNotifEst_(val) {
  if (!val && val !== 0) return "";
  if (val instanceof Date) {
    var h = val.getHours(), m = val.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  var s = String(val).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;
  try {
    var d = new Date(s);
    if (!isNaN(d.getTime())) {
      var h2 = d.getHours(), m2 = d.getMinutes();
      return (h2 < 10 ? "0" : "") + h2 + ":" + (m2 < 10 ? "0" : "") + m2;
    }
  } catch (e) { /* ignorar */ }
  return s;
}


// ── Construcción del email ────────────────────────────────────

function _construirEmailEstudiante_(info) {
  var nombre = info.firstName + " " + info.lastName;

  var aulasHtml = info.aulas.map(function(a) {
    var docenteHtml = a.teacherName
      ? '<div style="font-size:12px;color:#777;margin-bottom:2px;">' +
          'Docente: <strong>' + a.teacherName + '</strong>' +
        '</div>'
      : '';
    var horarioHtml = (a.diaLabel && a.startTime && a.endTime)
      ? '<div style="font-size:12px;color:#555;margin-bottom:10px;">' +
          '<strong>' + a.diaLabel + '</strong>' +
          ' &nbsp;&middot;&nbsp; ' +
          a.startTime + ' &ndash; ' + a.endTime +
          (a.weeklyHours ? ' &nbsp;&middot;&nbsp; ' + a.weeklyHours + ' h/sem' : '') +
        '</div>'
      : '';

    return '<tr>' +
      '<td style="padding:16px 18px;border-bottom:1px solid #f0f4f8;">' +

        // Nombre de la asignatura
        '<div style="font-weight:700;color:#1a3c5e;font-size:15px;margin-bottom:5px;">' +
          a.subjectName +
        '</div>' +

        docenteHtml +
        horarioHtml +

        // Boton de acceso
        '<a href="' + a.enrollLink + '" ' +
           'style="display:inline-block;background:#1a3c5e;color:#ffffff;' +
                  'text-decoration:none;padding:9px 22px;border-radius:6px;' +
                  'font-size:14px;font-weight:600;letter-spacing:0.3px;">' +
          'Unirme al aula &rarr;' +
        '</a>' +

      '</td>' +
    '</tr>';
  }).join("");

  return '<!DOCTYPE html>' +
  '<html><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>' +
  '<body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif;">' +

  // ── Header ────────────────────────────────────────────────
  '<div style="background:#1a3c5e;padding:30px 24px 24px;text-align:center;">' +
    '<div style="color:#ffffff;font-size:26px;font-weight:700;letter-spacing:1px;">SIDEP</div>' +
    '<div style="color:#a8c8e8;font-size:13px;margin-top:5px;">Ecosistema Academico Digital</div>' +
  '</div>' +

  '<div style="background:#ffffff;max-width:620px;margin:0 auto;">' +

    // ── Saludo ────────────────────────────────────────────────
    '<div style="padding:30px 26px 16px;">' +
      '<p style="margin:0 0 6px;font-size:20px;color:#1a3c5e;font-weight:700;">' +
        'Hola, ' + info.firstName + '!' +
      '</p>' +
      '<p style="margin:0;font-size:15px;color:#444;line-height:1.7;">' +
        'Ya estas matriculado en tus aulas de Google Classroom. ' +
        'Aqui tienes toda la informacion que necesitas para comenzar.' +
      '</p>' +
    '</div>' +

    // ── Tarjeta de programa ───────────────────────────────────
    '<div style="margin:0 26px 20px;padding:16px 18px;' +
                'background:#f0f7ff;border-radius:10px;border-left:4px solid #1a3c5e;">' +
      '<table style="width:100%;border-collapse:collapse;">' +
        '<tr>' +
          '<td style="font-size:13px;color:#555;padding:3px 0;">' +
            '<strong style="color:#1a3c5e;">Programa:</strong>&nbsp;&nbsp;' +
            info.programName + ' <span style="color:#888;">(' + info.programCode + ')</span>' +
          '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="font-size:13px;color:#555;padding:3px 0;">' +
            '<strong style="color:#1a3c5e;">Cohorte de ingreso:</strong>&nbsp;&nbsp;' +
            info.entryCohortCode +
          '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="font-size:13px;color:#555;padding:3px 0;">' +
            '<strong style="color:#1a3c5e;">Ventana activa:</strong>&nbsp;&nbsp;' +
            info.windowCohortCode +
          '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="font-size:13px;color:#555;padding:3px 0;">' +
            '<strong style="color:#1a3c5e;">Asignaturas:</strong>&nbsp;&nbsp;' +
            info.aulas.length +
          '</td>' +
        '</tr>' +
      '</table>' +
    '</div>' +

    // ── Aviso importante ─────────────────────────────────────
    '<div style="margin:0 26px 20px;padding:14px 16px;background:#fff8e1;' +
                'border-radius:8px;border-left:4px solid #f9a825;">' +
      '<p style="margin:0;font-size:14px;color:#444;line-height:1.6;">' +
        '<strong>Como ingresar a tus aulas:</strong> Haz clic en el boton ' +
        '"Unirme al aula" de cada asignatura. ' +
        'Debes acceder desde tu cuenta de Gmail personal. ' +
        'Si ya estas registrado en el aula, el link te llevara directamente.' +
      '</p>' +
    '</div>' +

    // ── Tabla de asignaturas ──────────────────────────────────
    '<div style="padding:0 26px 16px;">' +
      '<p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#666;' +
                'text-transform:uppercase;letter-spacing:0.6px;">' +
        'Tus asignaturas' +
      '</p>' +
      '<table style="width:100%;border-collapse:collapse;' +
                    'border:1px solid #dde5f0;border-radius:10px;overflow:hidden;">' +
        aulasHtml +
      '</table>' +
    '</div>' +

    // ── Nota de soporte ───────────────────────────────────────
    '<div style="margin:0 26px 20px;padding:14px 16px;background:#e8f4fd;' +
                'border-radius:8px;border-left:4px solid #2e75b6;">' +
      '<p style="margin:0;font-size:14px;color:#1a3c5e;line-height:1.6;">' +
        '<strong>Recuerda:</strong> Revisa tu carpeta de Correos no deseados ' +
        'si no encuentras la invitacion de Classroom. ' +
        'Tambien puedes unirte directamente con el boton de arriba.' +
      '</p>' +
    '</div>' +

    // ── Footer ────────────────────────────────────────────────
    '<div style="padding:20px 26px;border-top:1px solid #f0f0f0;text-align:center;">' +
      '<p style="margin:0;font-size:13px;color:#999;">' +
        'Dudas o inconvenientes: ' +
        '<a href="mailto:scontreras@sidep.edu.co" style="color:#1a3c5e;">' +
          'scontreras@sidep.edu.co' +
        '</a>' +
      '</p>' +
      '<p style="margin:8px 0 0;font-size:12px;color:#bbb;">SIDEP &middot; 2026</p>' +
    '</div>' +

  '</div>' +
  '</body></html>';
}
