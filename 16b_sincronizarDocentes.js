// ============================================================
// SIDEP Ecosistema Digital — 06b_sincronizarDocentes.gs
// Versión : 1.0.0
// Autor   : Stevens Contreras
// Fecha   : 2026-03-26
//
// FIX-AUDIT A-2: Este archivo existía referenciado en 99_orquestador.gs
// pero no estaba creado → ReferenceError al ejecutar cualquier paso6b_*.
//
// PROPÓSITO:
//   Sincronizar el estado de invitaciones de docentes entre Classroom API
//   y la tabla TeacherAssignments en Sheets.
//
// PROBLEMA QUE RESUELVE:
//   Cuando se ejecuta importarDocentes() (paso 6), el sistema envía
//   invitaciones vía Classroom.Invitations.create() y registra
//   InvitationStatus = 'TEACHER_INVITED'. El docente luego acepta o
//   rechaza la invitación por email. Hasta que alguien actualice
//   TeacherAssignments manualmente, el registro dice TEACHER_INVITED
//   aunque el docente ya sea co-teacher activo en el aula.
//   Este script automatiza ese paso de actualización.
//
// LÓGICA DE SINCRONIZACIÓN (Invitations.get):
//   Una invitación de Classroom al ser ACEPTADA queda "consumida" —
//   Classroom la elimina y Invitations.get(id) devuelve 404.
//   Una invitación RECHAZADA también da 404 (no distinguible vía API).
//   Para determinar ACEPTADA vs RECHAZADA se complementa con:
//     Teachers.get({ courseId, userId }) → 200 = TEACHER_ACCEPTED
//                                         → 404 = TEACHER_DECLINED
//
// FLUJO:
//   1. Leer TeacherAssignments WHERE InvitationStatus = 'TEACHER_INVITED'
//   2. Por cada invitación pendiente:
//      a. Classroom.Invitations.get(InvitationID)
//         - 200 → sigue TEACHER_INVITED (aún no respondida)
//         - 404 → invitación consumida → verificar con Teachers.get()
//      b. Teachers.get({ courseId, userId })
//         - 200 → TEACHER_ACCEPTED → actualizar IsActive = true
//         - 404 → TEACHER_DECLINED
//   3. Escribir actualizaciones en batch (pattern memory-first)
//   4. Registrar en AutomationLogs
//
// CUOTAS:
//   Classroom API: ~5 calls por docente (get invitation + get teacher).
//   Con 7 docentes actuales = ~35 llamadas por ejecución. Sin problemas.
//
// TRIGGER AUTOMÁTICO:
//   configurarTriggerDiario() instala un trigger a las 7 AM cada día.
//   Eliminar con eliminarTriggerDiario() cuando todos digan TEACHER_ACCEPTED.
//
// DEPENDE DE:
//   00_SIDEP_CONFIG.gs → getSpreadsheetByName(), nowSIDEP(), uuid()
//   06_importarDocentes.gs → estructura de TeacherAssignments
//   Google Classroom API v1 (habilitada en Editor GAS → ➕ Servicios)
//
// FUNCIONES PÚBLICAS:
//   sincronizarInvitaciones(opts)    → sincronización principal
//   configurarTriggerDiario()        → instalar trigger 7 AM diario
//   eliminarTriggerDiario()          → eliminar trigger
//   diagnosticoInvitaciones()        → estado sin modificar nada
// ============================================================


// ─────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Sincroniza el estado de invitaciones de docentes con Classroom API.
 * Actualiza TeacherAssignments: TEACHER_INVITED → TEACHER_ACCEPTED o TEACHER_DECLINED.
 *
 * @param {Object}  [opts]
 * @param {boolean} [opts.dryRun] — true: muestra cambios en Logger sin escribir en Sheets
 */
function sincronizarInvitaciones(opts) {
  var options  = opts || {};
  var dryRun   = options.dryRun === true;
  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();
  var inicio   = Date.now();
  var logResult = 'ERROR';
  var logMsg    = '';

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log('⚠️  Lock ocupado — sincronizarInvitaciones ya está corriendo. ' +
               'Espera 30s e intenta de nuevo.');
    return;
  }
  Logger.log('🔐 Lock adquirido');

  var adminSS;
  var conteo = { verificadas: 0, aceptadas: 0, rechazadas: 0, pendientes: 0, errores: 0 };

  try {
    Logger.log('════════════════════════════════════════════════');
    Logger.log('🔄 SIDEP — sincronizarInvitaciones v1.0' + (dryRun ? ' [DRY RUN]' : ''));
    Logger.log('   Ejecutor : ' + ejecutor);
    Logger.log('   Ahora    : ' + ahora);
    Logger.log('════════════════════════════════════════════════');

    if (typeof Classroom === 'undefined') {
      throw new Error(
        'Classroom API no habilitada. ' +
        'Editor GAS → ➕ Servicios → Google Classroom API v1 → Agregar'
      );
    }

    adminSS = getSpreadsheetByName('admin');
    var coreSS = getSpreadsheetByName('core');

    // ── PASO 1: Leer TeacherAssignments en memoria ────────────────────────────
    Logger.log('\n── PASO 1/3: Leyendo TeacherAssignments en memoria ──');
    var memAsig = _leerHojaSync_(adminSS, 'TeacherAssignments');
    var memDepl = _leerHojaSync_(coreSS,  'MasterDeployments');
    Logger.log('  TeacherAssignments : ' + memAsig.datos.length + ' filas');

    // ── PASO 2: Verificar invitaciones pendientes via Classroom API ───────────
    Logger.log('\n── PASO 2/3: Verificando invitaciones pendientes ──');

    var colInvId  = memAsig.colIdx['InvitationID'];
    var colInvSt  = memAsig.colIdx['InvitationStatus'];
    var colDepId  = memAsig.colIdx['DeploymentID'];
    var colTchId  = memAsig.colIdx['TeacherID'];
    var colIsAct  = memAsig.colIdx['IsActive'];
    var colUpdAt  = memAsig.colIdx['UpdatedAt'];
    var colUpdBy  = memAsig.colIdx['UpdatedBy'];

    // Índice deploymentId → classroomId para resolver courseId
    var deplIdx = {};
    var colDeplId  = memDepl.colIdx['DeploymentID'];
    var colCid     = memDepl.colIdx['ClassroomID'];
    var colTchEmail = memAsig.colIdx['TeacherID']; // TeacherID, no email — necesitamos email
    if (colDeplId !== undefined && colCid !== undefined) {
      memDepl.datos.forEach(function(fila) {
        var id  = String(fila[colDeplId] || '').trim();
        var cid = String(fila[colCid]    || '').trim();
        if (id && cid) deplIdx[id] = cid;
      });
    }

    // Índice TeacherID → Email desde la hoja Teachers
    var memTch = _leerHojaSync_(coreSS, 'Teachers');
    var tchEmailIdx = {};
    var iTchId    = memTch.colIdx['TeacherID'];
    var iTchEmail = memTch.colIdx['Email'];
    if (iTchId !== undefined && iTchEmail !== undefined) {
      memTch.datos.forEach(function(fila) {
        var tid   = String(fila[iTchId]    || '').trim();
        var email = String(fila[iTchEmail] || '').trim();
        if (tid && email) tchEmailIdx[tid] = email;
      });
    }

    var modificadas = []; // { rowIdx, nuevoStatus, isActive }

    memAsig.datos.forEach(function(fila, rowIdx) {
      var invStatus = String(fila[colInvSt] || '').trim();
      if (invStatus !== 'TEACHER_INVITED') return; // solo procesar INVITED

      var invId  = String(fila[colInvId] || '').trim();
      var deplId = String(fila[colDepId] || '').trim();
      var tchId  = String(fila[colTchId] || '').trim();

      conteo.verificadas++;

      var courseId = deplIdx[deplId];
      if (!courseId) {
        Logger.log('  ⚠️  Fila ' + (rowIdx + 2) + ': DeploymentID ' + deplId +
                   ' sin ClassroomID — omitida');
        return;
      }

      var emailDocente = tchEmailIdx[tchId] || tchId;

      // Sin InvitationID: el docente es owner o ya era miembro cuando se procesó.
      // Ir directo al check Teachers.get() sin pasar por Invitations.get().
      if (!invId) {
        Logger.log('  ℹ️  Fila ' + (rowIdx + 2) + ': sin InvitationID (posible owner) — ' +
                   'verificando membresía directa para ' + emailDocente);
        try {
          Classroom.Courses.Teachers.get(courseId, emailDocente);
          conteo.aceptadas++;
          Logger.log('  ✅ ACEPTADA (owner/ya-miembro): ' + emailDocente);
          modificadas.push({ rowIdx: rowIdx, nuevoStatus: 'TEACHER_ACCEPTED', isActive: true });
        } catch (eOwner) {
          Logger.log('  ⚠️  No encontrado en el aula: ' + emailDocente +
                     ' — se deja como TEACHER_INVITED para reintento manual.');
        }
        return;
      }

      try {
        // Intentar obtener la invitación
        Classroom.Invitations.get(invId);
        // 200 → invitación sigue pendiente (no respondida)
        conteo.pendientes++;
        Logger.log('  ⏳ Pendiente         : teacher=' + tchId + ', inv=' + invId);

      } catch (e) {
        var esNotFound = e.message && (
          e.message.indexOf('404') !== -1 ||
          e.message.toLowerCase().indexOf('not found') !== -1
        );

        if (!esNotFound) {
          Logger.log('  ❌ Error verificando inv ' + invId + ': ' + e.message);
          conteo.errores++;
          return;
        }

        // 404 → invitación consumida → determinar ACEPTADA o RECHAZADA
        var nuevoStatus, isActive;

        try {
          Classroom.Courses.Teachers.get(courseId, emailDocente);
          // 200 → docente ya es co-teacher → ACEPTADA
          nuevoStatus = 'TEACHER_ACCEPTED';
          isActive    = true;
          conteo.aceptadas++;
          Logger.log('  ✅ ACEPTADA          : ' + emailDocente + ' → courseId=' + courseId);

        } catch (eTch) {
          // 404 → no está en el aula → RECHAZADA
          nuevoStatus = 'TEACHER_DECLINED';
          isActive    = false;
          conteo.rechazadas++;
          Logger.log('  ❌ RECHAZADA         : ' + emailDocente + ' → courseId=' + courseId);
        }

        modificadas.push({ rowIdx: rowIdx, nuevoStatus: nuevoStatus, isActive: isActive });
      }
    });

    // ── PASO 3: Escribir actualizaciones en batch ─────────────────────────────
    Logger.log('\n── PASO 3/3: Escribiendo actualizaciones ──');

    if (modificadas.length === 0) {
      Logger.log('  ⬜ Nada que actualizar.');
    } else if (dryRun) {
      Logger.log('  [DRY RUN] — ' + modificadas.length + ' filas se actualizarían:');
      modificadas.forEach(function(m) {
        Logger.log('    Fila ' + (m.rowIdx + 2) + ' → ' + m.nuevoStatus +
                   ', IsActive=' + m.isActive);
      });
    } else {
      // Aplicar cambios en memoria
      modificadas.forEach(function(m) {
        memAsig.datos[m.rowIdx][colInvSt] = m.nuevoStatus;
        memAsig.datos[m.rowIdx][colIsAct] = m.isActive;
        memAsig.datos[m.rowIdx][colUpdAt] = ahora;
        memAsig.datos[m.rowIdx][colUpdBy] = ejecutor;
      });

      // Escribir TODO en un setValues (mismo rango, datos completos) — pattern memory-first
      var hoja     = memAsig.hoja;
      var numFilas = memAsig.datos.length;
      if (numFilas > 0) {
        hoja.getRange(2, 1, numFilas, memAsig.encabezado.length)
            .setValues(memAsig.datos);
        Logger.log('  ✅ TeacherAssignments actualizada: ' + modificadas.length +
                   ' filas (1 setValues)');
      }
    }

    // ── RESUMEN ───────────────────────────────────────────────────────────────
    var dur = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log('\n════════════════════════════════════════════════');
    Logger.log((dryRun ? '🔍 DRY RUN' : '✅ Sincronización') + ' completada en ' + dur + 's');
    Logger.log('  Verificadas  : ' + conteo.verificadas);
    Logger.log('  Aceptadas    : ' + conteo.aceptadas);
    Logger.log('  Rechazadas   : ' + conteo.rechazadas);
    Logger.log('  Pendientes   : ' + conteo.pendientes);
    Logger.log('  Errores API  : ' + conteo.errores);
    Logger.log('════════════════════════════════════════════════');

    if (conteo.pendientes > 0) {
      Logger.log('  ⏳ ' + conteo.pendientes + ' docente(s) aún no han respondido la invitación.');
      Logger.log('     El trigger diario re-verificará automáticamente.');
    }
    if (conteo.rechazadas > 0) {
      Logger.log('  ⚠️  ' + conteo.rechazadas + ' docente(s) rechazaron la invitación.');
      Logger.log('     Usar importarDocentes() para reenviar → el script es idempotente.');
    }

    logResult = conteo.errores > 0 ? 'PARTIAL' : 'SUCCESS';
    logMsg    = conteo.errores > 0 ? conteo.errores + ' error(es) de Classroom API' : '';

  } catch (e) {
    logResult = 'ERROR';
    logMsg    = e.message || String(e);
    Logger.log('❌ ERROR en sincronizarInvitaciones: ' + logMsg);
    throw e;

  } finally {
    if (adminSS && !dryRun) {
      try {
        var logHoja = adminSS.getSheetByName('AutomationLogs');
        if (logHoja) {
          logHoja.appendRow([
            uuid('log'), 'CLASSROOM', 'SYNC_INVITATIONS', 'sincronizarInvitaciones',
            logResult, conteo.aceptadas + conteo.rechazadas, logMsg || '',
            nowSIDEP(), Session.getEffectiveUser().getEmail()
          ]);
        }
      } catch (eLog) {
        Logger.log('⚠️  No se pudo escribir AutomationLog: ' + eLog.message);
      }
    }
    lock.releaseLock();
    Logger.log('🔓 Lock liberado');
  }
}


// ─────────────────────────────────────────────────────────────
// TRIGGER AUTOMÁTICO
// ─────────────────────────────────────────────────────────────

/**
 * Instala un trigger diario a las 7 AM que ejecuta sincronizarInvitaciones().
 * Ejecutar UNA sola vez después de importarDocentes().
 * El trigger corre hasta que eliminarTriggerDiario() lo quite.
 *
 * Idempotente: si ya existe un trigger de sincronización, no crea otro.
 */
function configurarTriggerDiario() {
  var TRIGGER_FUNC = 'sincronizarInvitaciones';

  // Verificar si ya existe un trigger para esta función
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TRIGGER_FUNC) {
      Logger.log('⚠️  Ya existe un trigger para ' + TRIGGER_FUNC + '. No se creó uno nuevo.');
      Logger.log('   TriggerID: ' + triggers[i].getUniqueId());
      return;
    }
  }

  var trigger = ScriptApp.newTrigger(TRIGGER_FUNC)
    .timeBased()
    .atHour(7)
    .everyDays(1)
    .inTimezone(SIDEP_CONFIG.timezone)
    .create();

  Logger.log('✅ Trigger diario instalado: ' + TRIGGER_FUNC + ' a las 7 AM (Bogotá)');
  Logger.log('   TriggerID: ' + trigger.getUniqueId());
  Logger.log('   Eliminar con: eliminarTriggerDiario()');
}

/**
 * Elimina todos los triggers de sincronizarInvitaciones().
 * Usar cuando todos los docentes hayan aceptado (0 TEACHER_INVITED pendientes).
 */
function eliminarTriggerDiario() {
  var TRIGGER_FUNC = 'sincronizarInvitaciones';
  var triggers     = ScriptApp.getProjectTriggers();
  var eliminados   = 0;

  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === TRIGGER_FUNC) {
      ScriptApp.deleteTrigger(trigger);
      eliminados++;
      Logger.log('🗑️  Trigger eliminado: ' + trigger.getUniqueId());
    }
  });

  if (eliminados === 0) {
    Logger.log('⚠️  No se encontró ningún trigger para ' + TRIGGER_FUNC + '.');
  } else {
    Logger.log('✅ ' + eliminados + ' trigger(s) de sincronización eliminado(s).');
  }
}


// ─────────────────────────────────────────────────────────────
// DIAGNÓSTICO — solo lectura
// ─────────────────────────────────────────────────────────────

/**
 * Muestra el estado de las invitaciones de docentes sin modificar nada.
 * Ejecutar en cualquier momento para ver el progreso de aceptación.
 */
function diagnosticoInvitaciones() {
  Logger.log('════════════════════════════════════════════════');
  Logger.log('🔍 SIDEP — Diagnóstico de Invitaciones de Docentes v1.0');
  Logger.log('════════════════════════════════════════════════');

  try {
    var adminSS = getSpreadsheetByName('admin');
    var memAsig = _leerHojaSync_(adminSS, 'TeacherAssignments');

    var colInvSt  = memAsig.colIdx['InvitationStatus'];
    var colIsAct  = memAsig.colIdx['IsActive'];
    var colDepId  = memAsig.colIdx['DeploymentID'];

    var porStatus = {};
    var activos   = 0;

    memAsig.datos.forEach(function(fila) {
      var st  = String(fila[colInvSt] || 'SIN_STATUS').trim();
      var act = fila[colIsAct];
      porStatus[st] = (porStatus[st] || 0) + 1;
      if (act === true) activos++;
    });

    Logger.log('\n  TeacherAssignments: ' + memAsig.datos.length + ' registros');
    Logger.log('  Co-teachers activos (IsActive=true): ' + activos);
    Logger.log('\n  Por InvitationStatus:');
    Object.keys(porStatus).sort().forEach(function(s) {
      var marker = s === 'TEACHER_INVITED' ? '⏳' :
                   s === 'TEACHER_ACCEPTED' ? '✅' :
                   s === 'TEACHER_DECLINED' ? '❌' : '❓';
      Logger.log('    ' + marker + ' ' + s + ': ' + porStatus[s]);
    });

    // Verificar triggers activos
    var triggers = ScriptApp.getProjectTriggers();
    var triggerSync = triggers.filter(function(t) {
      return t.getHandlerFunction() === 'sincronizarInvitaciones';
    });
    Logger.log('\n  Trigger diario activo: ' + (triggerSync.length > 0 ? 'SÍ ✅' : 'NO —'));
    if (triggerSync.length === 0 && (porStatus['TEACHER_INVITED'] || 0) > 0) {
      Logger.log('  → Recomendación: instalar trigger con configurarTriggerDiario()');
    }
    if (triggerSync.length > 0 && (porStatus['TEACHER_INVITED'] || 0) === 0) {
      Logger.log('  → Todos aceptaron. Eliminar trigger con eliminarTriggerDiario()');
    }

    Logger.log('\n════════════════════════════════════════════════');
  } catch (e) {
    Logger.log('❌ ERROR en diagnosticoInvitaciones: ' + e.message);
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS
// ─────────────────────────────────────────────────────────────

/**
 * Lee una hoja completa en UNA llamada Sheets API.
 * Mismo patrón que _leerHojaCompleta_ en 06_importarDocentes.gs.
 */
function _leerHojaSync_(ss, nombreHoja) {
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) {
    throw new Error(
      "Hoja '" + nombreHoja + "' no encontrada en '" + ss.getName() + "'. " +
      '¿Ejecutaste setupSidepTables()?'
    );
  }

  var lastRow = hoja.getLastRow();
  var lastCol = hoja.getLastColumn();

  if (lastRow === 0 || lastCol === 0) {
    return {
      hoja: hoja, nombreHoja: nombreHoja,
      encabezado: [], datos: [], colIdx: {}
    };
  }

  var encabezado = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIdx     = {};
  encabezado.forEach(function(nombre, i) {
    if (nombre !== '') colIdx[String(nombre)] = i;
  });

  var datos = [];
  if (lastRow > 1) {
    datos = hoja.getRange(2, 1, lastRow - 1, lastCol).getValues()
              .filter(function(fila) {
                return fila.some(function(c) { return c !== ''; });
              });
  }

  return {
    hoja: hoja, nombreHoja: nombreHoja,
    encabezado: encabezado, datos: datos, colIdx: colIdx
  };
}
