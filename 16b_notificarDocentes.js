/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 16b_notificarDocentes.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Enviar un email personalizado a cada docente con su horario
 *   completo y los links directos a sus aulas de Classroom.
 *
 * CUÁNDO SE EJECUTA:
 *   Automáticamente al final de procesarStgAsignaciones() para las
 *   asignaciones recién creadas (InvitationStatus=TEACHER_INVITED).
 *   También disponible en el menú para reenvíos individuales.
 *
 * DIFERENCIA VS notificarEstudiantes():
 *   Estudiantes → necesitan enrollmentCode (cuentas Gmail externas)
 *   Docentes    → link directo al aula (cuentas @sidep.edu.co, ya son co-teachers)
 *                 + horario (DayOfWeek, StartTime, EndTime, WeeklyHours)
 *                 + recordatorio de aceptar la invitación de Classroom
 *
 * FUENTE DE DATOS:
 *   Teachers            → email, nombre
 *   TeacherAssignments  → horario (DayOfWeek/StartTime/EndTime) + InvitationStatus
 *   MasterDeployments   → ClassroomID, nombre del aula (GeneratedClassroomName)
 *   Sin llamadas a Classroom API — todo desde Sheets.
 *
 * FUNCIONES PÚBLICAS:
 *   notificarDocentes()                    → envía a todos los TEACHER_INVITED
 *   notificarDocentes({ dryRun: true })    → preview en Logger sin enviar
 *   notificarDocente_individual(email)     → reenvío a un docente específico
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs → getSpreadsheetByName(), nowSIDEP(), uuid()
 * ============================================================
 */


// ── Constantes ────────────────────────────────────────────────

var NOTIF_DOC_REMITENTE = "SIDEP Ecosistema Digital";
var NOTIF_DOC_ASUNTO    = "Tu horario de clases SIDEP \u2014 aulas asignadas";

var DIAS_LABEL = {
  "LUNES":     "Lunes",
  "MARTES":    "Martes",
  "MIERCOLES": "Miércoles",
  "JUEVES":    "Jueves",
  "VIERNES":   "Viernes",
  "SABADO":    "Sábado"
};


// ── Función principal ─────────────────────────────────────────

/**
 * Envía un email a cada docente con TEACHER_INVITED informando
 * su horario completo y los links directos a sus aulas.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun]    — preview sin enviar
 * @param {string}  [opts.soloEmail] — enviar solo a este docente
 */
function notificarDocentes(opts) {
  var options   = opts || {};
  var dryRun    = options.dryRun    === true;
  var soloEmail = options.soloEmail ? options.soloEmail.toLowerCase().trim() : null;
  var ahora     = nowSIDEP();
  var ejecutor  = Session.getEffectiveUser().getEmail();
  var inicio    = Date.now();
  var conteo    = { enviados: 0, omitidos: 0, errores: 0, sinAulas: 0 };

  Logger.log("════════════════════════════════════════════════");
  Logger.log("📧 SIDEP — notificarDocentes v1.0" + (dryRun ? " [DRY RUN]" : ""));
  Logger.log("   Ejecutor : " + ejecutor);
  if (soloEmail) Logger.log("   Filtro   : " + soloEmail);
  Logger.log("════════════════════════════════════════════════");

  var adminSS, logResult = "ERROR", logMsg = "";

  try {
    var coreSS = getSpreadsheetByName("core");
    adminSS    = getSpreadsheetByName("admin");

    // ── PASO 1: Leer tablas en memoria ────────────────────────
    Logger.log("\n── Leyendo tablas en memoria ──");
    var memTch  = _leerHojaEmailDoc_(coreSS,  "Teachers");
    var memAsig = _leerHojaEmailDoc_(adminSS, "TeacherAssignments");
    var memDepl = _leerHojaEmailDoc_(coreSS,  "MasterDeployments");
    Logger.log("  Teachers           : " + memTch.datos.length);
    Logger.log("  TeacherAssignments : " + memAsig.datos.length);
    Logger.log("  MasterDeployments  : " + memDepl.datos.length);

    // ── PASO 2: Índices ───────────────────────────────────────
    var tchIdx  = _indexarTeachers_(memTch);   // teacherId → { email, firstName, lastName }
    var deplIdx = _indexarDeplDoc_(memDepl);   // deploymentId → { classroomId, nombre }

    // ── PASO 3: Agrupar asignaciones por docente ──────────────
    var porDocente = _agruparPorDocente_(memAsig, tchIdx, deplIdx);
    Logger.log("  Docentes con asignaciones TEACHER_INVITED: " +
               Object.keys(porDocente).length);

    // ── PASO 4: Enviar emails ─────────────────────────────────
    Logger.log("\n── " + (dryRun ? "Preview (DRY RUN)" : "Enviando emails") + " ──");

    Object.keys(porDocente).forEach(function(email) {
      if (soloEmail && email !== soloEmail) return;

      var info = porDocente[email];

      if (info.aulas.length === 0) {
        Logger.log("  ⬜ Sin aulas: " + email);
        conteo.sinAulas++;
        return;
      }

      var cuerpo = _construirEmailDocente_(info);

      if (dryRun) {
        Logger.log("\n  📧 [DRY RUN] Para: " + email);
        Logger.log("     Nombre : " + info.firstName + " " + info.lastName);
        Logger.log("     Aulas  : " + info.aulas.length);
        info.aulas.forEach(function(a) {
          Logger.log("       · " + a.nombre + " | " + a.dia + " " +
                     a.startTime + "-" + a.endTime + " | " + a.link);
        });
        conteo.enviados++;
        return;
      }

      try {
        GmailApp.sendEmail(email, NOTIF_DOC_ASUNTO, "", {
          name     : NOTIF_DOC_REMITENTE,
          htmlBody : cuerpo,
          replyTo  : ejecutor
        });
        Logger.log("  ✅ Enviado: " + email + " (" + info.aulas.length + " aulas)");
        conteo.enviados++;
      } catch (eEmail) {
        Logger.log("  ❌ Error enviando a " + email + ": " + eEmail.message);
        conteo.errores++;
      }
    });

    // ── Resumen ───────────────────────────────────────────────
    var dur = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log("\n════════════════════════════════════════════════");
    Logger.log((dryRun ? "🔍 DRY RUN" : "✅ Notificaciones") + " completadas en " + dur + "s");
    Logger.log("  Emails " + (dryRun ? "simulados" : "enviados") + " : " + conteo.enviados);
    Logger.log("  Sin aulas : " + conteo.sinAulas);
    Logger.log("  Errores   : " + conteo.errores);
    Logger.log("════════════════════════════════════════════════");

    logResult = conteo.errores > 0 ? "PARTIAL" : "SUCCESS";
    logMsg    = conteo.errores > 0 ? conteo.errores + " email(s) fallaron" : "";

  } catch (e) {
    logResult = "ERROR";
    logMsg    = e.message || String(e);
    Logger.log("❌ ERROR: " + logMsg);
    throw e;

  } finally {
    if (adminSS && !dryRun) {
      try {
        var logHoja = adminSS.getSheetByName("AutomationLogs");
        if (logHoja) {
          logHoja.appendRow([
            uuid("log"), "GMAIL", "NOTIFY_TEACHERS", "notificarDocentes",
            logResult, conteo.enviados, logMsg || "",
            nowSIDEP(), Session.getEffectiveUser().getEmail()
          ]);
        }
      } catch (eLog) {
        Logger.log("⚠️  No se pudo escribir AutomationLog: " + eLog.message);
      }
    }
  }
}

/** Preview sin enviar. */
function notificarDocentes_dryRun() {
  notificarDocentes({ dryRun: true });
}

/**
 * Reenvía el email a un docente específico.
 * Útil si el docente no recibió el correo o necesita el horario de nuevo.
 * Ejemplo: notificarDocente_individual("mrivera@sidep.edu.co")
 */
function notificarDocente_individual(email) {
  if (!email) {
    Logger.log("⚠️  Especifica el email: notificarDocente_individual('email@sidep.edu.co')");
    return;
  }
  notificarDocentes({ soloEmail: email });
}


// ── Helpers de datos ─────────────────────────────────────────

function _leerHojaEmailDoc_(ss, nombreHoja) {
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) throw new Error("Hoja '" + nombreHoja + "' no encontrada en '" + ss.getName() + "'.");
  var lastRow = hoja.getLastRow();
  var lastCol = hoja.getLastColumn();
  if (lastRow === 0 || lastCol === 0) {
    return { hoja: hoja, encabezado: [], datos: [], colIdx: {} };
  }
  var encabezado = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIdx = {};
  encabezado.forEach(function(n, i) { if (n !== "") colIdx[String(n)] = i; });
  var datos = lastRow > 1
    ? hoja.getRange(2, 1, lastRow - 1, lastCol).getValues()
          .filter(function(f) { return f.some(function(c) { return c !== ""; }); })
    : [];
  return { hoja: hoja, encabezado: encabezado, datos: datos, colIdx: colIdx };
}

/** teacherId → { email, firstName, lastName } */
function _indexarTeachers_(mem) {
  var idx = {};
  var c   = mem.colIdx;
  mem.datos.forEach(function(f) {
    var id = String(f[c["TeacherID"]] || "").trim();
    if (!id) return;
    idx[id] = {
      email     : String(f[c["Email"]]     || "").toLowerCase().trim(),
      firstName : String(f[c["FirstName"]] || "").trim(),
      lastName  : String(f[c["LastName"]]  || "").trim()
    };
  });
  return idx;
}

/** deploymentId → { classroomId, nombre } */
function _indexarDeplDoc_(mem) {
  var idx = {};
  var c   = mem.colIdx;
  mem.datos.forEach(function(f) {
    var id  = String(f[c["DeploymentID"]]           || "").trim();
    var cid = String(f[c["ClassroomID"]]            || "").trim();
    var nom = String(f[c["GeneratedClassroomName"]] || "").trim();
    if (id) idx[id] = { classroomId: cid, nombre: nom };
  });
  return idx;
}

/**
 * Agrupa asignaciones TEACHER_INVITED por email de docente.
 * @returns {{ email → { firstName, lastName, aulas: [{nombre, dia, startTime, endTime, weeklyHours, link}] } }}
 */
function _agruparPorDocente_(memAsig, tchIdx, deplIdx) {
  var grupos = {};
  var c      = memAsig.colIdx;

  memAsig.datos.forEach(function(f) {
    var invStatus = String(f[c["InvitationStatus"]] || "").trim();
    // Notificar a docentes recién invitados — no esperar aceptación
    if (invStatus !== "TEACHER_INVITED") return;

    var tchId  = String(f[c["TeacherID"]]    || "").trim();
    var deplId = String(f[c["DeploymentID"]] || "").trim();
    var tch    = tchIdx[tchId];
    var depl   = deplIdx[deplId];

    if (!tch || !tch.email || !depl || !depl.classroomId) return;

    var dia         = String(f[c["DayOfWeek"]]  || "").trim();
    var startTime   = _formatearTiempoNotif_(f[c["StartTime"]]);
    var endTime     = _formatearTiempoNotif_(f[c["EndTime"]]);
    var weeklyHours = Number(f[c["WeeklyHours"]] || 0);
    var link       = "https://classroom.google.com/c/" + depl.classroomId;

    if (!grupos[tch.email]) {
      grupos[tch.email] = {
        firstName : tch.firstName,
        lastName  : tch.lastName,
        aulas     : []
      };
    }

    grupos[tch.email].aulas.push({
      nombre      : depl.nombre,
      dia         : dia,
      diaLabel    : DIAS_LABEL[dia] || dia,
      startTime   : startTime,
      endTime     : endTime,
      weeklyHours : weeklyHours,
      link        : link
    });
  });

  // Ordenar aulas por día de semana
  var ORDEN_DIA = { "LUNES": 1, "MARTES": 2, "MIERCOLES": 3, "JUEVES": 4, "VIERNES": 5, "SABADO": 6 };
  Object.keys(grupos).forEach(function(email) {
    grupos[email].aulas.sort(function(a, b) {
      return (ORDEN_DIA[a.dia] || 9) - (ORDEN_DIA[b.dia] || 9);
    });
  });

  return grupos;
}


// ── Formateo de tiempo ────────────────────────────────────────

/**
 * Convierte un valor de tiempo a "HH:mm".
 * Sheets devuelve tiempos como Date(1899-12-30 HH:MM) — no como string.
 * También soporta strings "HH:mm" ya formateados (data nueva).
 */
function _formatearTiempoNotif_(val) {
  if (!val && val !== 0) return "";
  if (val instanceof Date) {
    var h = val.getHours();
    var m = val.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  var s = String(val).trim();
  // Ya en formato HH:mm — devolver directo
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;
  // Llegó como toString() de Date (bug de datos anteriores) — re-parsear
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

function _construirEmailDocente_(info) {
  var nombre = info.firstName + " " + info.lastName;

  var aulasHtml = info.aulas.map(function(a) {
    return '<tr>' +
      '<td style="padding:14px 16px;border-bottom:1px solid #f0f0f0;">' +

        // Nombre del aula
        '<div style="font-weight:700;color:#1a3c5e;font-size:15px;margin-bottom:6px;">' +
          a.nombre +
        '</div>' +

        // Horario
        '<div style="font-size:13px;color:#555;margin-bottom:10px;">' +
          '<strong>' + a.diaLabel + '</strong>' +
          ' &nbsp;&middot;&nbsp; ' +
          a.startTime + ' &ndash; ' + a.endTime +
          ' &nbsp;&middot;&nbsp; ' +
          a.weeklyHours + ' h/sem' +
        '</div>' +

        // Link directo
        '<a href="' + a.link + '" ' +
           'style="display:inline-block;background:#1a3c5e;color:#ffffff;' +
                  'text-decoration:none;padding:8px 20px;border-radius:6px;' +
                  'font-size:14px;font-weight:600;">' +
          'Ir al aula &rarr;' +
        '</a>' +

      '</td>' +
    '</tr>';
  }).join("");

  return '<!DOCTYPE html>' +
  '<html><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>' +
  '<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">' +

  // Header
  '<div style="background:#1a3c5e;padding:28px 24px;text-align:center;">' +
    '<div style="color:#ffffff;font-size:22px;font-weight:700;">SIDEP</div>' +
    '<div style="color:#a8c8e8;font-size:13px;margin-top:4px;">Ecosistema Académico Digital</div>' +
  '</div>' +

  '<div style="background:#ffffff;max-width:600px;margin:0 auto;">' +

    // Saludo
    '<div style="padding:28px 24px 16px;">' +
      '<p style="margin:0 0 8px;font-size:18px;color:#1a3c5e;font-weight:700;">' +
        'Hola, ' + info.firstName +
      '</p>' +
      '<p style="margin:0;font-size:15px;color:#444;line-height:1.6;">' +
        'A continuación encontrarás tu horario de clases y los accesos directos ' +
        'a tus aulas virtuales en Google Classroom.' +
      '</p>' +
    '</div>' +

    // Aviso invitación pendiente
    '<div style="margin:0 24px;padding:12px 16px;background:#fff8e1;border-radius:8px;' +
                'border-left:4px solid #f9a825;">' +
      '<p style="margin:0;font-size:14px;color:#444;">' +
        '<strong>Acción requerida:</strong> Debes <strong>aceptar la invitación</strong> ' +
        'que Classroom te envió por email para aparecer como co-docente activo en cada aula. ' +
        'Hasta que la aceptes, los estudiantes no te verán como docente del curso.' +
      '</p>' +
    '</div>' +

    // Tabla de aulas
    '<div style="padding:20px 24px 8px;">' +
      '<p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#666;' +
                'text-transform:uppercase;letter-spacing:0.5px;">Tus aulas asignadas</p>' +
      '<table style="width:100%;border-collapse:collapse;border:1px solid #e0e0e0;' +
                    'border-radius:8px;overflow:hidden;">' +
        aulasHtml +
      '</table>' +
    '</div>' +

    // Nota
    '<div style="margin:16px 24px;padding:12px 16px;background:#e8f4fd;border-radius:8px;' +
                'border-left:4px solid #2e75b6;">' +
      '<p style="margin:0;font-size:14px;color:#1a3c5e;">' +
        '<strong>¿Cómo acceder?</strong> El botón "Ir al aula" te lleva directamente ' +
        'al aula en Google Classroom. Inicia sesión con tu cuenta <strong>@sidep.edu.co</strong>.' +
      '</p>' +
    '</div>' +

    // Footer
    '<div style="padding:20px 24px;border-top:1px solid #f0f0f0;text-align:center;">' +
      '<p style="margin:0;font-size:13px;color:#999;">' +
        '¿Tienes dudas? Escríbenos a ' +
        '<a href="mailto:scontreras@sidep.edu.co" style="color:#1a3c5e;">' +
          'scontreras@sidep.edu.co' +
        '</a>' +
      '</p>' +
      '<p style="margin:8px 0 0;font-size:12px;color:#bbb;">SIDEP · 2026</p>' +
    '</div>' +

  '</div>' +
  '</body></html>';
}
