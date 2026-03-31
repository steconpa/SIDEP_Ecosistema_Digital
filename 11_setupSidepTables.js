/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL
 * Archivo: 11_setupSidepTables.gs
 * Versión: 3.8.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Crear los 3 Spreadsheets, definir todas las hojas con sus
 *   encabezados y registrar la versión del deploy.
 *   CERO datos — los datos van en 02_poblarConfiguraciones.gs.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs  → SIDEP_CONFIG
 *   01_SIDEP_TABLES.gs  → CORE_TABLES, ADMIN_TABLES, BI_TABLES
 *   02_SIDEP_HELPERS.gs → getRootFolderSafe(), getOrCreateSpreadsheet(),
 *                         nowSIDEP(), registrarTablasSheetsAPI_()
 *   10_inicializarEcosistema.gs → estructura de carpetas Drive (se llama
 *                                   automáticamente si la raíz no existe)
 *   Sheets Advanced Service → ya habilitado en el proyecto
 *
 * SPREADSHEETS QUE CREA O VERIFICA:
 *   SIDEP_01_CORE_ACADEMICO  → tablas de configuración, deployments, docentes
 *   SIDEP_02_GESTION_ADMIN   → tablas de estudiantes, matrículas, riesgo
 *   SIDEP_03_BI_DASHBOARD    → vistas agregadas para métricas ejecutivas
 *   Todos se crean dentro de: 00_SIDEP_ECOSISTEMA_DIGITAL/01_BASES_DE_DATOS_MAESTRAS/
 *
 * MODOS DE EJECUCIÓN:
 *   SAFE  (default) → preserva datos existentes, solo refresca encabezados.
 *                     Seguro de re-ejecutar en cualquier momento.
 *   FORCE           → limpia y recrea todas las hojas. ⚠️ DESTRUYE DATOS.
 *                     Usar solo en entornos de prueba o reset total.
 *                     Adquiere LockService para prevenir ejecuciones concurrentes.
 *
 * USO DIRECTO:
 *   setupSidepTables()                           — SAFE (idempotente)
 *   setupSidepTables({ force: true })            — FORCE (destructivo)
 *   setupSidepTables({ environment: 'STAGING' }) — registra entorno en _SYS_VERSION
 *
 * VÍA ORQUESTADOR (recomendado):
 *   paso1_tablas()        → SAFE via 99_orquestador.gs
 *   paso1_tablas_force()  → FORCE via 99_orquestador.gs
 *
 * INTEGRACIÓN AUTOMÁTICA:
 *   Si getRootFolderSafe() falla (primera ejecución desde cero),
 *   llama a inicializarEcosistema() y reintenta. Se puede ejecutar
 *   setupSidepTables() directamente sin haber corrido 00b antes.
 *
 * PROTECCIÓN DE TABLAS:
 *   Las hojas _CFG_* y _SYS_* reciben protección setWarningOnly(true).
 *   Advierte al usuario antes de editar, pero no bloquea.
 *   Fase 2: cambiar a setWarningOnly(false) + addEditor(owner) para
 *   protección real que solo el owner pueda modificar.
 *
 * REGISTRO DE VERSIONES (_SYS_VERSION):
 *   Cada ejecución AGREGA una fila — nunca sobrescribe.
 *   Permite auditar el historial completo de deploys:
 *   quién ejecutó, cuándo, cuántas tablas, en qué entorno y en cuánto tiempo.
 *
 * FORMATOS AUTOMÁTICOS:
 *   configurarTablas_() NO aplica formatos (checkboxes, fechas, números).
 *   Los formatos se aplican en 03_poblarSyllabus.gs DESPUÉS de escribir
 *   datos reales. Razón: insertCheckboxes() sobre celdas vacías hace que
 *   getLastRow() retorne > 1, engañando a tablasVacias_() y haciendo
 *   creer que la tabla ya tiene datos cuando está vacía.
 *
 * VERSIÓN: 3.9.0
 *
 * CAMBIOS v3.9.0 vs v3.8.0:
 *   - NUEVO Paso 3.5: registrarTablasSheetsAPI_() después de configurarTablas_().
 *     Registra cada hoja como Tabla nativa de Google Sheets vía Sheets Advanced Service.
 *     Idempotente: SAFE omite tablas ya existentes, FORCE las elimina y recrea.
 *     Beneficios: AppSheet lee por nombre de tabla, Looker conecta directo,
 *     referencias estructuradas en fórmulas (=FILTER(Students[Email], ...)).
 *   - Actualizado DEPENDE DE: lista 01_SIDEP_TABLES.gs y 02_SIDEP_HELPERS.gs
 *     explícitamente (separación SRP v4.2.0).
 *   - Actualizado resumen del log: muestra conteo de tablas API registradas.
 *
 * CAMBIOS v3.8.0 vs v3.7.0:
 *   - getRootFolderSafe() en lugar de DriveApp.getFoldersByName() directo.
 *     FIX crítico si hay múltiples carpetas con el mismo nombre en Drive.
 *   - FILE_MAP + forEach: los 3 Spreadsheets se procesan en loop en lugar
 *     de 3 bloques de código idénticos. Elimina duplicación y centraliza.
 *   - registrarVersion_() usa nowSIDEP() — timezone correcto en Bogotá.
 *     new Date() directo podía registrar UTC en lugar de UTC-5.
 *   - protegerTablasConfig_() usa descripción fija "SIDEP_CONFIG" en lugar
 *     de "SIDEP v3.x.x". Con versión en el string, cada actualización de
 *     modelo creaba una protección adicional en vez de reconocer la existente.
 *   - Logger incluye usuario ejecutor al inicio.
 *
 * CAMBIOS v3.4.0 (referencia histórica):
 *   - LockService en modo FORCE para prevenir condición de carrera.
 *   - Separación explícita de pasos: carpetas → SS → hojas → protección → versión.
 * ============================================================
 */

function setupSidepTables(options) {
  var opts         = options || {};
  opts.force       = opts.force       || false;
  opts.environment = opts.environment || "PRODUCTION";

  var tiempoInicio = Date.now();
  var totalTablas  = Object.keys(CORE_TABLES).length +
                     Object.keys(ADMIN_TABLES).length +
                     Object.keys(BI_TABLES).length;

  // LockService: previene condición de carrera en ejecuciones force concurrentes
  var lock = null;
  if (opts.force) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      throw new Error("⚠️ Lock ocupado. Espera 30s e intenta de nuevo.");
    }
    Logger.log("🔐 Lock adquirido");
  }

  try {
    Logger.log("════════════════════════════════════════════════");
    Logger.log("🚀 SIDEP v" + SIDEP_CONFIG.modelVersion + " — setupSidepTables");
    Logger.log("   Modo    : " + (opts.force ? "FORCE" : "SAFE"));
    Logger.log("   Entorno : " + opts.environment);
    Logger.log("   Tablas  : " + totalTablas);
    Logger.log("════════════════════════════════════════════════");

    // ── 1. Carpetas ───────────────────────────────────────
    // getRootFolderSafe() usa ScriptProperties (caché O(1)).
    // Si falla (primera ejecución desde cero), auto-inicializa carpetas.
    var root;
    try {
      root = getRootFolderSafe();
    } catch (e) {
      Logger.log("⚠️  Raíz no encontrada → inicializarEcosistema()...");
      inicializarEcosistema();
      root = getRootFolderSafe();
    }
    var dbIter   = root.getFoldersByName(SIDEP_CONFIG.dbFolderName);
    var dbFolder = dbIter.hasNext()
      ? dbIter.next()
      : root.createFolder(SIDEP_CONFIG.dbFolderName);
    Logger.log("📁 " + root.getName() + "/" + dbFolder.getName());

    // ── 2. Spreadsheets ───────────────────────────────────
    // FILE_MAP procesa los 3 SS en loop — elimina 3 bloques de código idénticos.
    var FILE_MAP = [
      { key: "core",  tables: CORE_TABLES  },
      { key: "admin", tables: ADMIN_TABLES },
      { key: "bi",    tables: BI_TABLES    }
    ];
    var spreadsheets = {};
    FILE_MAP.forEach(function(f) {
      var ss = getOrCreateSpreadsheet(SIDEP_CONFIG.files[f.key], dbFolder);
      limpiarHojaDefault_(ss);
      spreadsheets[f.key] = ss;
    });

    // ── 3. Hojas ──────────────────────────────────────────
    FILE_MAP.forEach(function(f) {
      Logger.log("\n📋 " + SIDEP_CONFIG.files[f.key]);
      configurarTablas_(spreadsheets[f.key], f.tables, opts.force);
    });

    var coreSS  = spreadsheets["core"];
    var adminSS = spreadsheets["admin"];
    var biSS    = spreadsheets["bi"];

    // ── 3.5 Tablas nativas Sheets API ────────────────────
    // Registra cada hoja como Tabla nativa usando Sheets Advanced Service.
    // Beneficios: AppSheet + Looker leen por nombre de tabla, referencias
    // estructuradas en fórmulas, auto-expand visual en Sheets UI.
    // Idempotente: SAFE omite tablas ya existentes, FORCE las recrea.
    Logger.log("\n🗂️  Registrando Tablas nativas (Sheets API)...");
    var tablasPorSS = 0;
    FILE_MAP.forEach(function(f) {
      Logger.log("  📋 " + SIDEP_CONFIG.files[f.key]);
      registrarTablasSheetsAPI_(spreadsheets[f.key], f.tables, opts.force);
      tablasPorSS += Object.keys(f.tables).length;
    });

    // ── 4. Protección ─────────────────────────────────────
    Logger.log("\n🔒 Protegiendo _CFG_* y _SYS_*...");
    protegerTablasConfig_(coreSS);
    protegerTablasConfig_(adminSS);

    // ── 5. Versión ────────────────────────────────────────
    registrarVersion_(coreSS, totalTablas, opts.environment, tiempoInicio);

    // ── 6. Resumen ────────────────────────────────────────
    var dur = ((Date.now() - tiempoInicio) / 1000).toFixed(1);
    Logger.log("\n════════════════════════════════════════════════");
    Logger.log("✅ Completado en " + dur + "s");
    Logger.log("   Tablas Sheets : " + totalTablas + " hojas → " + tablasPorSS + " Tablas API");
    Logger.log("   CORE  : " + coreSS.getUrl());
    Logger.log("   ADMIN : " + adminSS.getUrl());
    Logger.log("   BI    : " + biSS.getUrl());
    Logger.log("⏭  SIGUIENTE: poblarConfiguraciones()");
    Logger.log("════════════════════════════════════════════════");

  } catch (error) {
    Logger.log("❌ ERROR: " + error.message);
    throw error;
  } finally {
    if (lock) lock.releaseLock();
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS — sufijo _ indica uso exclusivo de este archivo
// ─────────────────────────────────────────────────────────────

/**
 * Elimina la hoja vacía que Google Sheets crea automáticamente al crear
 * un Spreadsheet nuevo ("Hoja 1" en español, "Sheet1" en inglés).
 * Solo la elimina si el SS ya tiene más de una hoja — nunca deja un SS vacío.
 */
function limpiarHojaDefault_(ss) {
  ["Hoja 1", "Sheet1", "Hoja1"].forEach(function(n) {
    var h = ss.getSheetByName(n);
    if (h && ss.getSheets().length > 1) ss.deleteSheet(h);
  });
}

/**
 * Crea o actualiza las hojas de un Spreadsheet según el objeto de tablas.
 *
 * SAFE (force=false):
 *   Si la hoja ya tiene datos (getLastRow > 1), solo refresca el encabezado
 *   (fila 1) y preserva todos los registros intactos.
 *   Si la hoja está vacía, la limpia y escribe el encabezado.
 *
 * FORCE (force=true):
 *   Limpia completamente la hoja y la recrea desde cero.
 *   ⚠️ DESTRUYE todos los datos existentes sin posibilidad de recuperación.
 *
 * En ambos modos: congela fila 1 y autoajusta el ancho de columnas.
 *
 * NO aplica formatos (checkboxes, fechas, números) — eso lo hace
 * aplicarFormatosAutomaticos_() en 03_poblarSyllabus.gs post-escritura.
 */
function configurarTablas_(ss, tables, force) {
  var s = SIDEP_CONFIG.headerStyle;
  Object.keys(tables).forEach(function(nombre) {
    var cols   = tables[nombre];
    var hoja   = ss.getSheetByName(nombre);
    var nueva  = !hoja;
    if (!hoja) hoja = ss.insertSheet(nombre);

    var tieneData = hoja.getLastRow() > 1;
    if (tieneData && !force) {
      // Solo refresca encabezado — registros intactos
      hoja.getRange(1, 1, 1, cols.length).setValues([cols])
          .setBackground(s.background).setFontColor(s.fontColor).setFontWeight(s.fontWeight);
      Logger.log("    ⏭  Preservada: " + nombre);
    } else {
      hoja.clear();
      hoja.getRange(1, 1, 1, cols.length).setValues([cols])
          .setBackground(s.background).setFontColor(s.fontColor).setFontWeight(s.fontWeight);
      Logger.log("    ✔  [" + (nueva ? "Nueva" : force ? "Recreada" : "Vacía") + "] " + nombre);
    }
    hoja.setFrozenRows(1);
    hoja.autoResizeColumns(1, cols.length);
  });
}

/**
 * Aplica protección de advertencia a todas las hojas _CFG_* y _SYS_*.
 *
 * setWarningOnly(true): muestra un diálogo de confirmación antes de editar,
 * pero no bloquea — cualquier usuario puede ignorarla. Suficiente para Fase 1
 * donde el equipo es pequeño y de confianza.
 *
 * Descripción fija "SIDEP_CONFIG" (sin número de versión): permite que
 * re-ejecuciones reconozcan la protección existente y no creen duplicados.
 * Con "SIDEP v3.6.0", al actualizar a v3.7.0 la condición
 * protections.length > 0 sería false (descripción diferente) y se agregaría
 * una segunda protección innecesaria sobre la misma hoja.
 *
 * El try/catch silencia el error si el usuario no tiene permisos suficientes
 * para crear protecciones (ej: editor sin permiso de owner).
 *
 * Fase 2 — protección real (solo owner puede editar):
 *   p.setWarningOnly(false);
 *   p.addEditor(Session.getEffectiveUser());
 */
function protegerTablasConfig_(ss) {
  ss.getSheets().forEach(function(h) {
    var n = h.getName();
    if (n.indexOf("_CFG_") !== 0 && n.indexOf("_SYS_") !== 0) return;
    if (h.getProtections(SpreadsheetApp.ProtectionType.SHEET).length > 0) return;
    try {
      var p = h.protect();
      p.setDescription("SIDEP_CONFIG");  // descripción fija — sin versión para no acumular protecciones
      p.setWarningOnly(true);
    } catch (e) { /* Sin permisos suficientes — ignorar */ }
  });
}

/**
 * Agrega una fila de auditoría a _SYS_VERSION en cada ejecución.
 * NUNCA sobrescribe — siempre appendea. Permite ver el historial
 * completo de deploys: quién, cuándo, cuántas tablas, entorno y duración.
 *
 * ScriptHash = timestamp ms de inicio (t0) — identificador único de ejecución.
 * Permite correlacionar esta fila con los logs de Apps Script si hay un error.
 */
function registrarVersion_(ss, totalTablas, env, t0) {
  var hoja = ss.getSheetByName("_SYS_VERSION");
  if (!hoja) return;
  var dur = ((Date.now() - t0) / 1000).toFixed(1);
  hoja.getRange(hoja.getLastRow() + 1, 1, 1, 9).setValues([[
    "ver_" + t0, SIDEP_CONFIG.modelVersion, "Estructura — sin datos",
    nowSIDEP(), Session.getEffectiveUser().getEmail(), String(t0),
    totalTablas, env, "OK en " + dur + "s"
  ]]);
}