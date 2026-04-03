/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 18_notificarEstudiantes.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Enviar un email personalizado a cada estudiante con los links
 *   directos para unirse a sus aulas de Google Classroom.
 *
 * CONTEXTO — POR QUÉ EXISTE ESTE SCRIPT:
 *   Los estudiantes usan cuentas Gmail personales (@gmail.com).
 *   Google Workspace tiene restricción de dominio que impide enviar
 *   invitaciones API directas a cuentas externas. El enrollmentCode
 *   de Classroom genera un link público que cualquier cuenta Google
 *   puede usar para unirse al aula sin restricciones de dominio.
 *   Link format: https://classroom.google.com/c/{courseId}?cjc={enrollmentCode}
 *
 * PREREQUISITOS:
 *   ✅ importarEstudiantes() ejecutado — Students y Enrollments en Sheets
 *   ✅ Aulas CREATED en MasterDeployments con ClassroomID válido
 *   ✅ GmailApp habilitado (automático en GAS)
 *   ✅ Classroom API habilitada (Editor → ➕ Servicios)
 *
 * FUNCIONES PÚBLICAS:
 *   notificarEstudiantes()        → envía emails a todos los estudiantes
 *   notificarEstudiantes_dryRun() → preview en Logger sin enviar nada
 *   diagnosticoNotificaciones()   → estado actual sin modificar nada
 *
 * ESTRATEGIA:
 *   1. Lee Students, Enrollments, MasterDeployments en memoria (3 Sheets calls)
 *   2. Por cada aula única: Classroom.Courses.get() para obtener enrollmentCode
 *      (1 API call por aula — ~12 aulas = 12 calls total)
 *   3. Agrupa enrollments por estudiante → construye lista de links
 *   4. Envía 1 email por estudiante con GmailApp (23 emails)
 *   5. Registra en AutomationLogs
 *
 *   Re-ejecutar es seguro: no hay estado que se duplique en Sheets.
 *   GmailApp puede enviar el mismo email dos veces si se re-ejecuta
 *   — solo hacerlo si es necesario (ej. estudiante no recibió el email).
 *
 * CUOTAS:
 *   GmailApp: 100 emails/día en Workspace (más que suficiente para 23).
 *   Classroom API (read): sin límite práctico.
 *
 * DEPENDE DE (constantes globales de 17_importarEstudiantes.gs):
 *   WINDOW_COHORT_ACTUAL — ventana activa (ej. 'MR26')
 *   MOMENTO_ACTUAL       — momento activo (ej. 'C1M2')
 *   FIX-AUDIT M-6: dependencia ahora documentada explícitamente.
 *   Si se refactoriza 07, actualizar o mover estas constantes a 00_SIDEP_CONFIG.gs.
 *
 * VERSIÓN: 1.1.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-17 (actualizado 2026-03-26)
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────

var EMAIL_REMITENTE_NOMBRE = "SIDEP Ecosistema Digital";
var EMAIL_ASUNTO           = "🎓 Tus aulas virtuales SIDEP — MR26 · C1M2";

// Nombre del programa legible para el email
var PROG_NOMBRES = {
  "ADM": "Aux. Administrativo",
  "MKT": "Marketing Digital",
  "SIS": "Sistemas con énfasis en Programación",
  "CTB": "Aux. Contable",
  "SST": "Seguridad y Salud en el Trabajo",
  "TRV": "Transversal"
};


// ─────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Envía un email personalizado a cada estudiante con los links
 * de sus aulas. Un email por estudiante, con todas sus aulas listadas.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun] — true: muestra emails en Logger sin enviar
 * @param {string}  [opts.soloEmail] — si se especifica, envía solo a ese email
 */
function notificarEstudiantes(opts) {
  var options    = opts || {};
  var dryRun     = options.dryRun === true;
  var soloEmail  = options.soloEmail ? options.soloEmail.toLowerCase().trim() : null;
  var ahora      = nowSIDEP();
  var ejecutor   = Session.getEffectiveUser().getEmail();
  var inicio     = Date.now();
  var logResult  = "ERROR";
  var logMsg     = "";

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log("⚠️  Lock ocupado. Espera 30s e intenta de nuevo.");
    return;
  }
  Logger.log("🔐 Lock adquirido");

  var adminSS;
  var conteo = { enviados: 0, omitidos: 0, errores: 0, sinAulas: 0 };

  try {
    Logger.log("════════════════════════════════════════════════");
    Logger.log("📧 SIDEP — notificarEstudiantes v1.1" + (dryRun ? " [DRY RUN]" : ""));
    Logger.log("   Ejecutor : " + ejecutor);
    Logger.log("   Ventana  : " + WINDOW_COHORT_ACTUAL + " · " + MOMENTO_ACTUAL);
    if (soloEmail) Logger.log("   Filtro   : " + soloEmail);
    Logger.log("════════════════════════════════════════════════");

    if (typeof Classroom === "undefined") {
      throw new Error(
        "Classroom API no habilitada. Editor → ➕ Servicios → Google Classroom API → Agregar"
      );
    }

    adminSS    = getSpreadsheetByName("admin");
    var coreSS = getSpreadsheetByName("core");

    // ── PASO 1: Leer tablas en memoria ────────────────────────
    Logger.log("\n── Leyendo tablas en memoria ──");
    var memStu  = _leerHojaEmail_(adminSS, "Students");
    var memEnr  = _leerHojaEmail_(adminSS, "Enrollments");
    var memDepl = _leerHojaEmail_(coreSS,  "MasterDeployments");
    Logger.log("  Students      : " + memStu.datos.length);
    Logger.log("  Enrollments   : " + memEnr.datos.length);
    Logger.log("  Deployments   : " + memDepl.datos.length);

    // ── PASO 2: Índices en memoria ────────────────────────────
    var stuIdx  = _indexarStudents_(memStu);      // studentId → { email, firstName, prog }
    var deplMap = _indexarDeplMap_(memDepl);       // deploymentId → { classroomId, nombre }

    // ── PASO 3: Obtener enrollmentCodes de Classroom API ──────
    Logger.log("\n── Obteniendo enrollment codes de Classroom ──");
    var enrollCodes = _obtenerEnrollmentCodes_(deplMap); // classroomId → enrollmentCode
    Logger.log("  Aulas procesadas: " + Object.keys(enrollCodes).length);

    // ── PASO 4: Agrupar enrollments por estudiante ────────────
    var porEstudiante = _agruparPorEstudiante_(memEnr, stuIdx, deplMap, enrollCodes);
    Logger.log("  Estudiantes con aulas: " + Object.keys(porEstudiante).length);

    // ── PASO 5: Enviar emails ─────────────────────────────────
    Logger.log("\n── " + (dryRun ? "Preview de emails (DRY RUN)" : "Enviando emails") + " ──");

    Object.keys(porEstudiante).forEach(function(email) {
      if (soloEmail && email !== soloEmail) return;

      var info = porEstudiante[email];

      if (info.aulas.length === 0) {
        Logger.log("  ⬜ Sin aulas: " + email);
        conteo.sinAulas++;
        return;
      }

      var cuerpo = _construirEmail_(info);

      if (dryRun) {
        Logger.log("\n  📧 [DRY RUN] Para: " + email);
        Logger.log("     Nombre : " + info.firstName);
        Logger.log("     Aulas  : " + info.aulas.length);
        info.aulas.forEach(function(a) {
          Logger.log("       · " + a.nombre + " → " + a.link);
        });
        conteo.enviados++;
        return;
      }

      try {
        GmailApp.sendEmail(
          email,
          EMAIL_ASUNTO,
          "",  // plain text vacío — usamos HTML
          {
            name     : EMAIL_REMITENTE_NOMBRE,
            htmlBody : cuerpo,
            replyTo  : ejecutor
          }
        );
        Logger.log("  ✅ Enviado a: " + email + " (" + info.aulas.length + " aulas)");
        conteo.enviados++;
      } catch (eEmail) {
        Logger.log("  ❌ Error enviando a " + email + ": " + eEmail.message);
        conteo.errores++;
      }
    });

    // ── RESUMEN ───────────────────────────────────────────────
    var dur = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log("\n════════════════════════════════════════════════");
    Logger.log((dryRun ? "🔍 DRY RUN completado" : "✅ Notificaciones completadas") +
               " en " + dur + "s");
    Logger.log("  Emails " + (dryRun ? "simulados" : "enviados") + " : " + conteo.enviados);
    Logger.log("  Sin aulas       : " + conteo.sinAulas);
    Logger.log("  Errores         : " + conteo.errores);
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
            uuid("log"), "GMAIL", "NOTIFY_STUDENTS", "notificarEstudiantes",
            logResult, conteo.enviados, logMsg || "",
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

/** Preview sin enviar nada — muestra emails en el Logger. */
function notificarEstudiantes_dryRun() {
  notificarEstudiantes({ dryRun: true });
}

/**
 * Envía el email solo a un estudiante específico.
 * Útil para reenviar a alguien que no recibió el correo.
 * Ejemplo: notificarEstudiante_individual("juan@gmail.com")
 */
function notificarEstudiante_individual(email) {
  if (!email) {
    Logger.log("⚠️  Especifica el email: notificarEstudiante_individual('email@gmail.com')");
    return;
  }
  notificarEstudiantes({ soloEmail: email });
}


// ─────────────────────────────────────────────────────────────
// DIAGNÓSTICO
// ─────────────────────────────────────────────────────────────

/**
 * Muestra el estado actual: cuántos estudiantes, cuántos enrollments,
 * y una muestra de los links que se generarían.
 * Solo lectura — no envía nada.
 */
function diagnosticoNotificaciones() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔍 SIDEP — Diagnóstico de Notificaciones v1.0");
  Logger.log("════════════════════════════════════════════════");

  try {
    var adminSS    = getSpreadsheetByName("admin");
    var coreSS     = getSpreadsheetByName("core");
    var memStu     = _leerHojaEmail_(adminSS, "Students");
    var memEnr     = _leerHojaEmail_(adminSS, "Enrollments");
    var memDepl    = _leerHojaEmail_(coreSS,  "MasterDeployments");
    var stuIdx     = _indexarStudents_(memStu);
    var deplMap    = _indexarDeplMap_(memDepl);

    Logger.log("  Students en Sheets    : " + memStu.datos.length);
    Logger.log("  Enrollments en Sheets : " + memEnr.datos.length);

    // Contar aulas CREATED con ClassroomID
    var aulasCreadas = 0;
    Object.keys(deplMap).forEach(function(id) {
      if (deplMap[id].classroomId) aulasCreadas++;
    });
    Logger.log("  Aulas con ClassroomID : " + aulasCreadas);

    // Resumen por programa
    var porProg = {};
    memStu.datos.forEach(function(fila) {
      var p = String(fila[memStu.colIdx["ProgramCode"]] || "?");
      porProg[p] = (porProg[p] || 0) + 1;
    });
    Logger.log("\n  Estudiantes por programa:");
    Object.keys(porProg).sort().forEach(function(p) {
      Logger.log("    " + p + ": " + porProg[p]);
    });

    Logger.log("\n  ✅ Listo para ejecutar notificarEstudiantes()");
    Logger.log("  → Ejecuta primero notificarEstudiantes_dryRun() para preview.");
    Logger.log("════════════════════════════════════════════════");
  } catch (e) {
    Logger.log("❌ ERROR: " + e.message);
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS
// ─────────────────────────────────────────────────────────────

/** Lee hoja completa — mismo patrón corregido que 07 v1.1 */
function _leerHojaEmail_(ss, nombreHoja) {
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) throw new Error("Hoja '" + nombreHoja + "' no encontrada en '" + ss.getName() + "'.");
  var lastRow = hoja.getLastRow();
  var lastCol = hoja.getLastColumn();
  if (lastRow === 0 || lastCol === 0) {
    return { hoja:hoja, nombreHoja:nombreHoja, encabezado:[], datos:[], colIdx:{} };
  }
  var encabezado = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIdx = {};
  encabezado.forEach(function(n, i) { if (n !== "") colIdx[String(n)] = i; });
  var datos = [];
  if (lastRow > 1) {
    datos = hoja.getRange(2, 1, lastRow - 1, lastCol).getValues()
              .filter(function(f) { return f.some(function(c) { return c !== ""; }); });
  }
  return { hoja:hoja, nombreHoja:nombreHoja, encabezado:encabezado, datos:datos, colIdx:colIdx };
}

/** Índice studentId → { email, firstName, lastName, prog } */
function _indexarStudents_(mem) {
  var idx  = {};
  var c    = mem.colIdx;
  mem.datos.forEach(function(fila) {
    var id = String(fila[c["StudentID"]] || "").trim();
    if (!id) return;
    idx[id] = {
      email     : String(fila[c["Email"]]       || "").toLowerCase().trim(),
      firstName : String(fila[c["FirstName"]]   || "").trim(),
      lastName  : String(fila[c["LastName"]]    || "").trim(),
      prog      : String(fila[c["ProgramCode"]] || "").trim()
    };
  });
  return idx;
}

/** Índice deploymentId → { classroomId, nombre } */
function _indexarDeplMap_(mem) {
  var idx  = {};
  var c    = mem.colIdx;
  mem.datos.forEach(function(fila) {
    var id  = String(fila[c["DeploymentID"]]           || "").trim();
    var cid = String(fila[c["ClassroomID"]]            || "").trim();
    var nom = String(fila[c["GeneratedClassroomName"]] || "").trim();
    if (!id) return;
    idx[id] = { classroomId: cid, nombre: nom };
  });
  return idx;
}

/**
 * Obtiene el enrollmentCode de cada aula única via Classroom API.
 * Una llamada por aula — ~12 calls total para MR26/C1M2.
 * @returns {Object} { classroomId → enrollmentCode }
 */
function _obtenerEnrollmentCodes_(deplMap) {
  var codes   = {};
  var vistos  = {};

  Object.keys(deplMap).forEach(function(deplId) {
    var cid = deplMap[deplId].classroomId;
    if (!cid || vistos[cid]) return;
    vistos[cid] = true;

    try {
      var curso = Classroom.Courses.get(cid);
      codes[cid] = curso.enrollmentCode || "";
      if (!curso.enrollmentCode) {
        Logger.log("  ⚠️  Sin enrollmentCode: " + (deplMap[deplId].nombre || cid));
      }
    } catch (e) {
      Logger.log("  ⚠️  Error obteniendo enrollmentCode para " +
                 (deplMap[deplId].nombre || cid) + ": " + e.message);
      codes[cid] = "";
    }
  });
  return codes;
}

/**
 * Agrupa enrollments por estudiante.
 * @returns {Object} { email → { firstName, lastName, prog, aulas:[{nombre, link}] } }
 */
function _agruparPorEstudiante_(memEnr, stuIdx, deplMap, enrollCodes) {
  var grupos = {};
  var c      = memEnr.colIdx;

  memEnr.datos.forEach(function(fila) {
    var stuId  = String(fila[c["StudentID"]]   || "").trim();
    var deplId = String(fila[c["DeploymentID"]] || "").trim();
    var winCoh = String(fila[c["WindowCohortCode"]] || "").trim();
    var mom    = String(fila[c["MomentCode"]]  || "").trim();

    // Solo procesar enrollments del período activo (constantes en 17_importarEstudiantes.gs)
    if (winCoh !== WINDOW_COHORT_ACTUAL || mom !== MOMENTO_ACTUAL) return;

    var stu = stuIdx[stuId];
    if (!stu || !stu.email) return;

    var depl = deplMap[deplId];
    if (!depl || !depl.classroomId) return;

    var code = enrollCodes[depl.classroomId];
    if (!code) return; // sin enrollmentCode → no incluir

    var link = "https://classroom.google.com/c/" + depl.classroomId +
               "?cjc=" + code;

    if (!grupos[stu.email]) {
      grupos[stu.email] = {
        firstName : stu.firstName,
        lastName  : stu.lastName,
        prog      : stu.prog,
        aulas     : []
      };
    }
    grupos[stu.email].aulas.push({
      nombre : depl.nombre,
      link   : link
    });
  });

  return grupos;
}

/**
 * Construye el HTML del email personalizado.
 * Diseño limpio y legible en móvil — los estudiantes lo abren desde el celular.
 */
function _construirEmail_(info) {
  var nombre    = info.firstName + " " + info.lastName;
  var progNom   = PROG_NOMBRES[info.prog] || info.prog;

  // Construir lista de aulas
  var aulasHtml = info.aulas.map(function(a) {
    return '<tr>' +
      '<td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;">' +
        '<div style="font-weight:600;color:#1a3c5e;font-size:15px;">' + a.nombre + '</div>' +
        '<div style="margin-top:8px;">' +
          '<a href="' + a.link + '" ' +
             'style="display:inline-block;background:#1a3c5e;color:#ffffff;' +
                    'text-decoration:none;padding:8px 20px;border-radius:6px;' +
                    'font-size:14px;font-weight:600;">' +
            '🔗 Unirse al aula' +
          '</a>' +
        '</div>' +
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

  // Saludo
  '<div style="background:#ffffff;max-width:600px;margin:0 auto;">' +
    '<div style="padding:28px 24px 16px;">' +
      '<p style="margin:0 0 8px;font-size:18px;color:#1a3c5e;font-weight:700;">' +
        'Hola, ' + info.firstName + ' 👋' +
      '</p>' +
      '<p style="margin:0;font-size:15px;color:#444;line-height:1.6;">' +
        'Te damos la bienvenida al período <strong>MR26 · C1M2</strong> del programa de ' +
        '<strong>' + progNom + '</strong>. ' +
        'A continuación encontrarás los links para unirte a tus aulas virtuales.' +
      '</p>' +
    '</div>' +

    // Instrucción
    '<div style="margin:0 24px;padding:12px 16px;background:#e8f4fd;border-radius:8px;' +
                'border-left:4px solid #2e75b6;">' +
      '<p style="margin:0;font-size:14px;color:#1a3c5e;">' +
        '<strong>¿Cómo unirte?</strong> Haz clic en el botón de cada aula. ' +
        'Google te pedirá que inicies sesión con tu cuenta Gmail — ' +
        'usa siempre la misma cuenta para todas las aulas.' +
      '</p>' +
    '</div>' +

    // Tabla de aulas
    '<div style="padding:16px 24px 8px;">' +
      '<p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#666;' +
                'text-transform:uppercase;letter-spacing:0.5px;">Tus aulas</p>' +
      '<table style="width:100%;border-collapse:collapse;border:1px solid #e0e0e0;' +
                    'border-radius:8px;overflow:hidden;">' +
        aulasHtml +
      '</table>' +
    '</div>' +

    // Nota importante
    '<div style="margin:16px 24px;padding:12px 16px;background:#fff8e1;border-radius:8px;' +
                'border-left:4px solid #f9a825;">' +
      '<p style="margin:0;font-size:14px;color:#444;">' +
        '<strong>⚠️ Importante:</strong> Cada link es de uso individual. ' +
        'No compartas estos links con personas externas al programa.' +
      '</p>' +
    '</div>' +

    // Footer
    '<div style="padding:20px 24px;border-top:1px solid #f0f0f0;text-align:center;">' +
      '<p style="margin:0;font-size:13px;color:#999;">' +
        '¿Tienes dudas? Escríbenos a ' +
        '<a href="mailto:scontreras@sidep.edu.co" style="color:#1a3c5e;">scontreras@sidep.edu.co</a>' +
      '</p>' +
      '<p style="margin:8px 0 0;font-size:12px;color:#bbb;">SIDEP · 2026</p>' +
    '</div>' +
  '</div>' +

  '</body></html>';
}
