/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 02_SIDEP_HELPERS.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Infraestructura reutilizable de bajo nivel — Drive, Sheets, utils.
 *   Disponibles en todos los archivos del proyecto sin imports.
 *   NUNCA contiene lógica de negocio ni definiciones de datos.
 *
 * REGLA DE ORO — SRP por archivo:
 *   00_SIDEP_CONFIG.gs  → parámetros del sistema
 *   01_SIDEP_TABLES.gs  → modelo de datos (tablas + constantes)
 *   02_SIDEP_HELPERS.gs → infraestructura reutilizable (Drive, Sheets, utils) ← este archivo
 *   02c_operacionesCatalogos.gs → lógica de negocio sobre catálogos
 *
 * FUNCIONES PÚBLICAS (sin sufijo _):
 *   getRootFolderSafe()                          → carpeta raíz con caché O(1)
 *   getSubFolder(parent, name)                   → subcarpeta dentro de un folder
 *   getOrCreateSpreadsheet(name, folder)         → obtiene o crea un Spreadsheet
 *   getSpreadsheetByName(fileKey)                → Spreadsheet existente por clave
 *   nowSIDEP()                                   → timestamp en America/Bogota
 *   uuid(prefix)                                 → ID prefijado legible
 *   aplicarFormatosAutomaticos_(ss, tables)      → formatos batch por convención
 *   aplicarFormatosHoja_(hoja, cols)             → formatos en una hoja
 *   getTableData(fileKey, tableName)             → lee tabla completa con índice de columnas
 *   escribirDatos(ss, tableName, rows)           → escritura batch sin rollback
 *   escribirDatosSeguro(ss, tableName, rows)     → escritura batch CON rollback
 *   registrarTablasSheetsAPI_(ss, tables, force) → registra hojas como Tablas nativas
 *   sincronizarRangosTablas_(ss, tables)         → resincroniza rangos de Tablas nativas
 *   aplicarDropdownsCatalogo(ss, tables)         → aplica DROPDOWN_CAT post-bootstrap
 *
 * FUNCIONES PRIVADAS (sufijo _ = uso interno):
 *   _leerHoja_(hoja)                             → lee hoja completa con índice de columnas
 *   _escribirEnBatch_(hoja, mem)                 → escribe memoria en Sheet en un batch
 *   _backupHoja_(hoja)                           → guarda contenido de hoja en memoria
 *   _restaurarHoja_(hoja, backup)                → restaura contenido desde backup
 *   _buildAddTableRequest_(sheetId, name, cols, maxRows) → request addTable con tipos
 *   _resolverTipoColumna_(tableName, col, idx, cache)    → tipo de una columna
 *   _construirCatalogCache_()                    → lee _CFG_* y devuelve mapa de valores
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs → SIDEP_CONFIG
 *   01_SIDEP_TABLES.gs → COLUMN_TYPES (para resolución de tipos de columna)
 *   Sheets Advanced Service → habilitado en el proyecto
 *
 * VERSIÓN: 1.2.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-27
 *
 * CAMBIOS v1.2.0 vs v1.1.0 — Tipos de columna (COLUMN_TYPES):
 *   - NUEVO _resolverTipoColumna_(tableName, colName, colIndex, catalogCache):
 *     Helper privado que determina el tipo de una columna consultando COLUMN_TYPES
 *     (definido en 01_SIDEP_TABLES.gs). Reglas de resolución en orden:
 *       1. Is*   → CHECKBOX (auto, sin consultar COLUMN_TYPES)
 *       2. *Date → DATE     (auto)
 *       3. *At   → DATE     (auto)
 *       4. COLUMN_TYPES[tableName][colName].type === "DROPDOWN_INLINE" → DROPDOWN (inline)
 *       5. COLUMN_TYPES[tableName][colName].type === "DROPDOWN_CAT"    → DROPDOWN (catalogo)
 *          Solo si catalogCache != null (post-bootstrap). En setup: omitido.
 *       6. Default → null (TEXT — no se declara, es el default de la API)
 *   - ACTUALIZADO _buildAddTableRequest_(): nueva firma (sheetId, tableName, cols, maxRows).
 *     cols = array de strings de nombres de columnas (antes era solo colCount).
 *     Ahora construye columnProperties llamando _resolverTipoColumna_() con
 *     catalogCache=null → aplica CHECKBOX, DATE, DROPDOWN_INLINE en setup.
 *     DROPDOWN_CAT se omite aquí — se aplica post-bootstrap via aplicarDropdownsCatalogo().
 *   - ACTUALIZADO registrarTablasSheetsAPI_(): pasa cols (array) en lugar de cols.length.
 *   - NUEVO _construirCatalogCache_(): lee los 6 catálogos _CFG_* de coreSS en un
 *     solo batch. Construye mapa { "_CFG_PROGRAMS": [...], "_CFG_STATUSES:RISK": [...] }.
 *     Usado por aplicarDropdownsCatalogo() para resolver DROPDOWN_CAT.
 *   - NUEVO aplicarDropdownsCatalogo(ss, tables): función pública genérica.
 *     Aplica TODOS los tipos (CHECKBOX + DATE + DROPDOWN_INLINE + DROPDOWN_CAT)
 *     vía updateTable. Safe to re-run: reemplaza columnProperties completas.
 *     Llamar después de poblarConfiguraciones() para que los catálogos tengan datos.
 *     Se puede llamar sobre cualquier Spreadsheet del ecosistema.
 *
 * CAMBIOS v1.1.0 vs v1.0.0 — Sheets API Tables:
 *   - Sección 5 completa: registrarTablasSheetsAPI_(), _buildAddTableRequest_(),
 *     sincronizarRangosTablas_().
 *
 * CAMBIOS v1.0.0:
 *   - Extraído de 00_SIDEP_CONFIG.gs (Sección 6). SRP v4.2.0.
 *   - Promovidos desde 02c: _leerHoja_(), _escribirEnBatch_(), _backupHoja_(), _restaurarHoja_()
 *   - NUEVO escribirDatosSeguro(), getRootFolder() @deprecated.
 * ============================================================
 */


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 1: HELPERS DE GOOGLE DRIVE
// ═════════════════════════════════════════════════════════════════

/**
 * Localiza la carpeta raíz del proyecto usando ScriptProperties como caché O(1).
 *
 * Primera llamada: busca por nombre en Drive y guarda el ID en ScriptProperties.
 * Llamadas siguientes: recupera el ID del caché sin escanear Drive.
 *
 * Ventajas vs getRootFolder() @deprecated:
 *   - Sin ambigüedad ante carpetas homónimas en Drive.
 *   - ~10× más rápido en ejecuciones sucesivas (O(1) vs O(n) búsqueda).
 *   - El ID en caché sobrevive cambios de nombre de la carpeta.
 *
 * Lanza Error descriptivo si la carpeta no existe ni en caché ni en Drive.
 */
function getRootFolderSafe() {
  const props  = PropertiesService.getScriptProperties();
  const cached = props.getProperty(SIDEP_CONFIG.propKeys.rootFolderId);

  // Intentar primero desde caché
  if (cached) {
    try {
      return DriveApp.getFolderById(cached);
    } catch (e) {
      // ID cacheado inválido (carpeta eliminada/movida) — limpiar y reintentar
      Logger.log("  ⚠️  Cache inválido para rootFolderId — buscando por nombre...");
      props.deleteProperty(SIDEP_CONFIG.propKeys.rootFolderId);
    }
  }

  // Fallback: búsqueda por nombre en Drive
  const folders = DriveApp.getFoldersByName(SIDEP_CONFIG.rootFolderName);
  if (!folders.hasNext()) {
    throw new Error(
      "📁 Carpeta raíz '" + SIDEP_CONFIG.rootFolderName + "' no encontrada en Drive. " +
      "Ejecuta inicializarEcosistema() o setupSidepTables() primero."
    );
  }
  const folder = folders.next();

  // Guardar en caché para todas las llamadas siguientes
  props.setProperty(SIDEP_CONFIG.propKeys.rootFolderId, folder.getId());
  Logger.log("  ✔  rootFolderId cacheado en ScriptProperties: " + folder.getId());
  return folder;
}

/**
 * @deprecated — usar getRootFolderSafe() que tiene caché O(1) via ScriptProperties.
 * Conservado para compatibilidad. Será eliminado en v5.0.
 */
function getRootFolder() {
  const folders = DriveApp.getFoldersByName(SIDEP_CONFIG.rootFolderName);
  if (!folders.hasNext()) {
    throw new Error(
      "📁 Carpeta raíz '" + SIDEP_CONFIG.rootFolderName + "' no encontrada en Drive. " +
      "Ejecuta inicializarEcosistema() o setupSidepTables() primero."
    );
  }
  return folders.next();
}

/**
 * Localiza una subcarpeta dentro de un folder padre.
 * Lanza Error descriptivo si no existe.
 *
 * @param {Folder} parentFolder — carpeta padre
 * @param {string} subFolderName — nombre de la subcarpeta a buscar
 * @returns {Folder}
 */
function getSubFolder(parentFolder, subFolderName) {
  const sub = parentFolder.getFoldersByName(subFolderName);
  if (!sub.hasNext()) {
    throw new Error(
      "📁 Subcarpeta '" + subFolderName + "' no encontrada dentro de '" +
      parentFolder.getName() + "'."
    );
  }
  return sub.next();
}

/**
 * Obtiene o crea un Spreadsheet en la carpeta indicada (idempotente).
 * Si ya existe: lo reutiliza. Si no: lo crea y mueve a la carpeta.
 * Llamado por setupSidepTables() para los 3 Spreadsheets del ecosistema.
 *
 * @param {string} name   — nombre del Spreadsheet
 * @param {Folder} folder — carpeta destino
 * @returns {Spreadsheet}
 */
function getOrCreateSpreadsheet(name, folder) {
  const files = folder.getFilesByName(name);
  if (files.hasNext()) {
    return SpreadsheetApp.open(files.next());
  }
  const ss   = SpreadsheetApp.create(name);
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(folder);
  Logger.log("  ➕ Spreadsheet creado: " + name);
  return ss;
}

/**
 * Obtiene un Spreadsheet existente por clave de SIDEP_CONFIG.files (sin crear).
 * Usa getRootFolderSafe() con caché O(1).
 *
 * @param {string} fileKey — "core" | "admin" | "bi"
 * @returns {Spreadsheet}
 */
function getSpreadsheetByName(fileKey) {
  const fileName = SIDEP_CONFIG.files[fileKey];
  if (!fileName) {
    throw new Error("fileKey inválido: '" + fileKey + "'. Usar: core | admin | bi");
  }
  const root     = getRootFolderSafe();
  const dbFolder = getSubFolder(root, SIDEP_CONFIG.dbFolderName);
  const files    = dbFolder.getFilesByName(fileName);
  if (!files.hasNext()) {
    throw new Error(
      "📄 Archivo '" + fileName + "' no encontrado en Drive. " +
      "Ejecuta setupSidepTables() primero."
    );
  }
  return SpreadsheetApp.open(files.next());
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 2: HELPERS DE UTILIDADES GENERALES
// ═════════════════════════════════════════════════════════════════

/**
 * Timestamp estandarizado en America/Bogota (UTC-5).
 *
 * SIEMPRE usar en lugar de new Date() directo en todos los scripts.
 * Razón: new Date() puede retornar UTC en servidores GAS alojados fuera de Colombia,
 * causando desfases de 5 horas en fechas del Semáforo y calendarios académicos.
 *
 * @returns {Date} objeto Date en timezone America/Bogota
 */
function nowSIDEP() {
  return Utilities.parseDate(
    Utilities.formatDate(new Date(), SIDEP_CONFIG.timezone, "yyyy-MM-dd HH:mm:ss"),
    SIDEP_CONFIG.timezone,
    "yyyy-MM-dd HH:mm:ss"
  );
}

/**
 * Genera un ID prefijado legible usando un fragmento del UUID de Utilities.
 *
 * Ejemplos:
 *   uuid("dep") → "dep_a1b2c3d4e5f6"
 *   uuid("apr") → "apr_9f8e7d6c5b4a"
 *   uuid("top") → "top_3c2b1a0f9e8d"
 *   uuid()      → "a1b2c3d4e5f6"
 *
 * Ventaja vs Utilities.getUuid(): el prefijo hace los IDs identificables
 * visualmente en Sheets y en el Logger sin conocer el contexto.
 *
 * @param  {string} [prefix] — ej: "dep", "apr", "enr", "top", "dbt", "cal"
 * @returns {string}
 */
function uuid(prefix) {
  const id = Utilities.getUuid().replace(/-/g, "").substring(0, 12);
  return prefix ? prefix + "_" + id : id;
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 3: HELPERS DE GOOGLE SHEETS — LECTURA Y ESCRITURA
// ═════════════════════════════════════════════════════════════════

/**
 * Escritura masiva en batch — respeta encabezado en fila 1.
 * Limpia filas antiguas ANTES de escribir (evita datos basura).
 * NUNCA usa loops individuales de celdas (preserva cuota de API de Sheets).
 *
 * USO: para escrituras simples donde no se necesita rollback.
 * Para escrituras que requieren protección ante fallos, usar escribirDatosSeguro().
 *
 * @param {Spreadsheet} ss        — Spreadsheet destino
 * @param {string}      tableName — nombre de la hoja destino
 * @param {Array[]}     rows      — array de arrays con los datos (sin encabezado)
 */
function escribirDatos(ss, tableName, rows) {
  if (!rows || rows.length === 0) return;
  const sheet = ss.getSheetByName(tableName);
  if (!sheet) {
    Logger.log("  ⚠️  Tabla no encontrada: " + tableName + " — ¿ejecutaste setupSidepTables()?");
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log("    🌱 " + tableName + " → " + rows.length + " registros");
}

/**
 * Escritura masiva CON backup en memoria y rollback automático.
 *
 * Flujo:
 *   1. Backup: lee datos actuales de la hoja en memoria.
 *   2. Limpia la hoja.
 *   3. Intenta escribir los nuevos datos.
 *   4. Si falla → restaura el backup automáticamente.
 *   5. Si ok   → log de éxito.
 *
 * Diferencias vs escribirDatos():
 *   escribirDatos()       → rápido, sin protección (para inicialización y bootstrap)
 *   escribirDatosSeguro() → protegido, con rollback (para producción, datos críticos)
 *
 * @param {Spreadsheet} ss        — Spreadsheet destino
 * @param {string}      tableName — nombre de la hoja destino
 * @param {Array[]}     rows      — array de arrays con los datos (sin encabezado)
 * @throws {Error} si la escritura falla (el backup ya fue restaurado al lanzar)
 */
function escribirDatosSeguro(ss, tableName, rows) {
  if (!rows || rows.length === 0) return;
  const sheet = ss.getSheetByName(tableName);
  if (!sheet) {
    throw new Error(
      "escribirDatosSeguro: tabla '" + tableName + "' no encontrada. " +
      "¿Ejecutaste setupSidepTables()?"
    );
  }

  // 1. Backup en memoria
  const backup = _backupHoja_(sheet);
  Logger.log("  💾 Backup: " + backup.datos.length + " filas guardadas en " + tableName);

  // 2. Limpiar
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }

  // 3. Escribir con protección
  try {
    sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    Logger.log("    🌱 " + tableName + " → " + rows.length + " registros (seguro)");
  } catch (e) {
    // 4. Rollback automático
    Logger.log("  ❌ ERROR al escribir en " + tableName + ": " + e.message);
    Logger.log("  🔄 Restaurando backup...");
    _restaurarHoja_(sheet, backup);
    Logger.log("  ✅ Backup restaurado — " + tableName + " intacta");
    throw new Error(
      "escribirDatosSeguro falló en " + tableName + ": " + e.message +
      "\nDatos originales restaurados correctamente."
    );
  }
}

/**
 * Lee una tabla del ecosistema con índice de columnas listo para usar.
 *
 * Wrapper público de _leerHoja_() que incluye la resolución del Spreadsheet.
 * Elimina el patrón repetido en los scripts operacionales:
 *
 *   // Antes — patrón repetido en 8+ scripts:
 *   const ss      = getSpreadsheetByName("core");
 *   const hoja    = ss.getSheetByName("MasterDeployments");
 *   const headers = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
 *   const iNom    = headers.indexOf("GeneratedNomenclature");
 *   // …acceso: datos[i][iNom]
 *
 *   // Ahora:
 *   const { datos, idx } = getTableData("core", "MasterDeployments");
 *   // …acceso: datos[i][idx["GeneratedNomenclature"]]
 *
 * @param {string} fileKey   — "core" | "admin" | "bi"
 * @param {string} tableName — nombre de la hoja (ej: "MasterDeployments")
 * @returns {{ ss, hoja, encabezado, datos, idx }}
 *   ss         — Spreadsheet del ecosistema
 *   hoja       — Sheet correspondiente
 *   encabezado — array de nombres de columnas (fila 1)
 *   datos      — array de arrays con filas de datos (sin encabezado)
 *   idx        — { colName: colIndex } — acceso O(1) por nombre de columna
 * @throws {Error} si fileKey es inválido o la tabla no existe en el Spreadsheet
 */
function getTableData(fileKey, tableName) {
  const ss   = getSpreadsheetByName(fileKey);
  const hoja = ss.getSheetByName(tableName);
  if (!hoja) {
    throw new Error(
      "getTableData: tabla '" + tableName + "' no encontrada en '" + fileKey + "'. " +
      "¿Ejecutaste setupSidepTables()?"
    );
  }
  const mem = _leerHoja_(hoja);
  return { ss: ss, hoja: hoja, encabezado: mem.encabezado, datos: mem.datos, idx: mem.idx };
}


/**
 * Lee una hoja completa en memoria con índice de columnas por nombre.
 * Útil para operaciones de upsert donde se necesita buscar filas existentes.
 *
 * @param {Sheet} hoja
 * @returns {{ hoja, encabezado, datos, idx }}
 *   hoja      — referencia a la Sheet
 *   encabezado — array de nombres de columnas
 *   datos     — array de arrays con filas de datos (sin encabezado)
 *   idx       — { colName: colIndex } para acceso por nombre
 */
function _leerHoja_(hoja) {
  const lastRow = hoja.getLastRow();
  const lastCol = hoja.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    return { hoja: hoja, encabezado: [], datos: [], idx: {} };
  }
  const encabezado = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
  const idx = {};
  encabezado.forEach(function(col, i) {
    if (col !== "") idx[String(col)] = i;
  });
  const datos = lastRow > 1
    ? hoja.getRange(2, 1, lastRow - 1, lastCol).getValues()
    : [];
  return { hoja: hoja, encabezado: encabezado, datos: datos, idx: idx };
}

/**
 * Escribe todos los datos en memoria de vuelta al Sheet en UN batch.
 * Limpia filas anteriores primero para evitar datos basura.
 *
 * @param {Sheet}  hoja — hoja de Google Sheets
 * @param {{ encabezado, datos }} mem — objeto retornado por _leerHoja_()
 */
function _escribirEnBatch_(hoja, mem) {
  if (mem.datos.length === 0) return;
  const lastRow = hoja.getLastRow();
  if (lastRow > 1) {
    hoja.getRange(2, 1, lastRow - 1, hoja.getLastColumn()).clearContent();
  }
  hoja.getRange(2, 1, mem.datos.length, mem.encabezado.length).setValues(mem.datos);
}

/**
 * Guarda el contenido actual de una hoja en memoria para rollback.
 * No modifica el Sheet — solo lectura.
 *
 * @param {Sheet} hoja
 * @returns {{ encabezado: string[], datos: Array[] }}
 */
function _backupHoja_(hoja) {
  const lastRow = hoja.getLastRow();
  const lastCol = hoja.getLastColumn();
  if (lastRow <= 1 || lastCol < 1) {
    return { encabezado: [], datos: [] };
  }
  const encabezado = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
  const datos      = hoja.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return { encabezado: encabezado, datos: datos };
}

/**
 * Restaura el contenido de una hoja desde un backup en memoria.
 * Limpia la hoja primero y luego escribe el backup en un batch.
 *
 * @param {Sheet}  hoja   — hoja de Google Sheets
 * @param {{ encabezado, datos }} backup — objeto retornado por _backupHoja_()
 */
function _restaurarHoja_(hoja, backup) {
  const lastRow = hoja.getLastRow();
  if (lastRow > 1) {
    hoja.getRange(2, 1, lastRow - 1, hoja.getLastColumn()).clearContent();
  }
  if (backup.datos.length > 0) {
    hoja.getRange(2, 1, backup.datos.length, backup.encabezado.length)
        .setValues(backup.datos);
  }
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 4: HELPERS DE FORMATO
// ═════════════════════════════════════════════════════════════════

/**
 * Aplica formatos (checkboxes, fechas, números) a TODAS las hojas
 * de un Spreadsheet según el objeto de tablas recibido.
 *
 * Llamada desde 03_poblarSyllabus.gs DESPUÉS de escribir datos reales.
 *
 * ¿Por qué post-escritura y no en setupSidepTables?
 *   insertCheckboxes() sobre celdas vacías hace que getLastRow() retorne > 1,
 *   engañando a tablasVacias_() y al modo SAFE de los pobladores.
 *
 * @param {Spreadsheet} ss     — Spreadsheet destino (CORE, ADMIN o BI)
 * @param {Object}      tables — objeto de tablas (ej: ADMIN_TABLES de 01_SIDEP_TABLES.gs)
 */
function aplicarFormatosAutomaticos_(ss, tables) {
  Object.keys(tables).forEach(function(nombre) {
    const hoja = ss.getSheetByName(nombre);
    if (!hoja) return;
    aplicarFormatosHoja_(hoja, tables[nombre]);
    Logger.log("    🎨 Formatos aplicados: " + nombre);
  });
}

/**
 * Aplica formatos a las columnas de una hoja según convención de nombre.
 *
 * Convenciones que disparan formato automático:
 *   Is*      → Checkbox  (booleano visual en Sheets)
 *   *Date    → Fecha     (yyyy-MM-dd)
 *   *At      → Datetime  (yyyy-MM-dd HH:mm)
 *   *Count   → Entero    (#,##0)
 *   *Order   → Entero    (#,##0)
 *
 * Solo aplica a filas de datos (fila 2 en adelante).
 * Seguro de ejecutar múltiples veces — sobreescribe el mismo formato.
 *
 * @param {Sheet}    hoja — hoja de Google Sheets
 * @param {string[]} cols — array de nombres de columnas (encabezado fila 1)
 */
function aplicarFormatosHoja_(hoja, cols) {
  const maxRows = Math.max(hoja.getMaxRows() - 1, 1);
  cols.forEach(function(col, i) {
    const colNum = i + 1;
    const rango  = hoja.getRange(2, colNum, maxRows, 1);
    if      (/^Is[A-Z]/.test(col))       rango.insertCheckboxes();
    else if (/Date$/.test(col))          rango.setNumberFormat("yyyy-MM-dd");
    else if (/At$/.test(col))           rango.setNumberFormat("yyyy-MM-dd HH:mm");
    else if (/Count$|Order$/.test(col)) rango.setNumberFormat("#,##0");
  });
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 5: SHEETS API — TABLAS NATIVAS
// ═════════════════════════════════════════════════════════════════
// Requiere: Sheets Advanced Service habilitado en el proyecto GAS.
// Ya habilitado en SIDEP_Ecosistema_Digital (visible en "Servicios").
//
// BENEFICIOS de registrar hojas como Tablas nativas:
//   1. AppSheet lee tablas por nombre (no por rango) → más robusto a cambios
//   2. Looker Studio conecta directamente con tablas tipadas
//   3. Referencias estructuradas en fórmulas: =FILTER(Students[Email], ...)
//   4. Auto-expand visual en Sheets UI al agregar filas
//   5. Nombre de tabla indexado → búsqueda más rápida en Sheets API queries
//
// ARQUITECTURA DE RANGO — decisión de diseño:
//   Opción A (elegida): rango full-sheet (row 0 → maxRows).
//     ✅ No requiere actualizar rango después de cada escritura.
//     ✅ AppSheet y Looker filtran filas vacías automáticamente.
//     ✅ Un solo batchUpdate por Spreadsheet al registrar.
//   Opción B: rango exacto (row 0 → lastRow tras cada escritura).
//     ❌ Requiere llamada API adicional en cada escribirDatos().
//     ❌ 2 API calls por tabla × N tablas = overhead significativo en pobladores.
//     ✅ Rango más "limpio" visualmente en la UI de Sheets.
//   sincronizarRangosTablas_() permite ejecutar Opción B cuando se necesite.

/**
 * Registra todas las hojas de un Spreadsheet como Tablas nativas de Sheets.
 *
 * IDEMPOTENTE:
 *   SAFE  (force=false) → omite hojas que ya tienen tabla registrada.
 *   FORCE (force=true)  → elimina tabla existente y la recrea.
 *     Necesario en FORCE de setupSidepTables() porque hoja.clear() borra datos
 *     pero NO elimina el objeto Tabla registrado en la Sheets API.
 *
 * EFICIENCIA:
 *   Una sola llamada Sheets.Spreadsheets.get() para leer estado actual.
 *   Un solo batchUpdate con todos los addTable agrupados.
 *   Si hay eliminaciones (FORCE), un batchUpdate de deletes + uno de adds.
 *
 * @param {Spreadsheet} ss     — Spreadsheet destino
 * @param {Object}      tables — objeto de tablas (CORE_TABLES, ADMIN_TABLES, BI_TABLES)
 * @param {boolean}     force  — true = eliminar tabla existente y recrear
 */
function registrarTablasSheetsAPI_(ss, tables, force) {
  const ssId = ss.getId();

  // ── 1. Leer estado actual de tablas en el SS (una sola llamada API) ──────
  let ssData;
  try {
    ssData = Sheets.Spreadsheets.get(ssId, { includeGridData: false });
  } catch (e) {
    Logger.log("  ⚠️  registrarTablasSheetsAPI_: no se pudo leer el SS → " + e.message);
    return;
  }

  // ── 2. Construir mapa: nombre de hoja → { sheetId, tableId, maxRows } ───
  const sheetMeta = {};
  ssData.sheets.forEach(function(s) {
    sheetMeta[s.properties.title] = {
      sheetId: s.properties.sheetId,
      maxRows: s.properties.gridProperties.rowCount,
      colCount: s.properties.gridProperties.columnCount,
      tableId: (s.tables && s.tables.length > 0) ? s.tables[0].tableId : null
    };
  });

  // ── 3. Clasificar en eliminaciones y adiciones ───────────────────────────
  const requestsDelete = [];
  const requestsAdd    = [];

  Object.keys(tables).forEach(function(tableName) {
    const cols = tables[tableName];
    const meta = sheetMeta[tableName];
    if (!meta) {
      Logger.log("  ⚠️  Hoja no encontrada para tabla: " + tableName);
      return;
    }

    if (meta.tableId) {
      if (force) {
        // FORCE: eliminar para recrear limpia
        requestsDelete.push({ deleteTable: { tableId: meta.tableId } });
        requestsAdd.push(_buildAddTableRequest_(meta.sheetId, tableName, cols, meta.maxRows));
        Logger.log("    🔄 Recrear tabla: " + tableName);
      } else {
        // SAFE: ya registrada, no tocar
        Logger.log("    ⏭  Tabla ya registrada: " + tableName);
      }
    } else {
      // No tiene tabla — registrar
      requestsAdd.push(_buildAddTableRequest_(meta.sheetId, tableName, cols, meta.maxRows));
      Logger.log("    ➕ Registrar tabla: " + tableName);
    }
  });

  // ── 4. Ejecutar en orden: primero eliminar, luego crear ──────────────────
  // Dos batchUpdate separados garantizan que los deletes se confirmen
  // antes de intentar crear tablas con los mismos nombres.
  try {
    if (requestsDelete.length > 0) {
      Sheets.Spreadsheets.batchUpdate({ requests: requestsDelete }, ssId);
      Logger.log("  🗑  " + requestsDelete.length + " tabla(s) eliminada(s) (FORCE)");
    }
    if (requestsAdd.length > 0) {
      Sheets.Spreadsheets.batchUpdate({ requests: requestsAdd }, ssId);
      Logger.log("  ✅ " + requestsAdd.length + " tabla(s) registrada(s) → Sheets API");
    }
    if (requestsDelete.length === 0 && requestsAdd.length === 0) {
      Logger.log("  ✔  Todas las tablas ya estaban registradas");
    }
  } catch (e) {
    Logger.log("  ❌ registrarTablasSheetsAPI_ error: " + e.message);
    throw e;
  }
}

/**
 * Construye el objeto request addTable para una hoja.
 *
 * RANGO FULL-SHEET: startRowIndex=0 → endRowIndex=maxRows.
 *   Cubre toda la hoja desde el encabezado hasta la última fila posible.
 *   Garantiza que cualquier dato escrito futuro quede dentro del rango
 *   sin necesidad de actualizar el rango después de cada escribirDatos().
 *
 * TIPOS APLICADOS EN SETUP (catalogCache=null):
 *   CHECKBOX, DATE, DROPDOWN_INLINE — no dependen de datos poblados.
 * TIPOS OMITIDOS EN SETUP:
 *   DROPDOWN_CAT — requieren catálogos poblados post-bootstrap.
 *   Se aplican después vía aplicarDropdownsCatalogo().
 *
 * @param {number}   sheetId   — ID numérico de la hoja (properties.sheetId)
 * @param {string}   tableName — nombre de la tabla (= nombre de la hoja en SIDEP)
 * @param {string[]} cols      — array de nombres de columnas (de *_TABLES)
 * @param {number}   maxRows   — total de filas de la hoja (gridProperties.rowCount)
 * @returns {Object} request addTable listo para batchUpdate
 */
function _buildAddTableRequest_(sheetId, tableName, cols, maxRows) {
  // Construir columnProperties — solo tipos aplicables en setup (sin catalog cache)
  const columnProperties = [];
  cols.forEach(function(colName, i) {
    const prop = _resolverTipoColumna_(tableName, colName, i, null);
    if (prop) columnProperties.push(prop);
  });

  const table = {
    name: tableName,
    range: {
      sheetId:          sheetId,
      startRowIndex:    0,
      endRowIndex:      maxRows,
      startColumnIndex: 0,
      endColumnIndex:   cols.length
    }
  };

  if (columnProperties.length > 0) {
    table.columnProperties = columnProperties;
  }

  return { addTable: { table: table } };
}

/**
 * Resincroniza el rango de cada Tabla nativa al lastRow real de la hoja.
 *
 * CUÁNDO USAR:
 *   No es necesaria en el flujo normal (el rango full-sheet ya cubre todo).
 *   Usar cuando se necesite un rango exacto, por ejemplo:
 *     - Antes de exportar la tabla como PDF
 *     - Antes de crear un pivot table sobre ella
 *     - Diagnóstico / auditoría del estado de las tablas
 *
 * EFICIENCIA:
 *   Una sola llamada Sheets.Spreadsheets.get() para leer todos los tableIds.
 *   Un solo batchUpdate con todos los updateTable agrupados.
 *
 * @param {Spreadsheet} ss     — Spreadsheet a sincronizar
 * @param {Object}      tables — objeto de tablas (CORE_TABLES, ADMIN_TABLES, BI_TABLES)
 */
function sincronizarRangosTablas_(ss, tables) {
  Logger.log("🔄 sincronizarRangosTablas_: " + ss.getName());
  const ssId = ss.getId();

  // ── 1. Leer estado actual ────────────────────────────────────────────────
  let ssData;
  try {
    ssData = Sheets.Spreadsheets.get(ssId, { includeGridData: false });
  } catch (e) {
    Logger.log("  ⚠️  No se pudo leer el SS: " + e.message);
    return;
  }

  // ── 2. Mapa: nombre → { sheetId, tableId, lastRow, colCount } ───────────
  const sheetMeta = {};
  ssData.sheets.forEach(function(s) {
    sheetMeta[s.properties.title] = {
      sheetId: s.properties.sheetId,
      tableId: (s.tables && s.tables.length > 0) ? s.tables[0].tableId : null
    };
  });

  // ── 3. Construir requests updateTable ────────────────────────────────────
  const requests = [];
  Object.keys(tables).forEach(function(tableName) {
    const meta  = sheetMeta[tableName];
    if (!meta || !meta.tableId) {
      Logger.log("    ⚠️  Sin tabla registrada: " + tableName);
      return;
    }
    const sheet   = ss.getSheetByName(tableName);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 1) return;

    requests.push({
      updateTable: {
        table: {
          tableId: meta.tableId,
          range: {
            sheetId:          meta.sheetId,
            startRowIndex:    0,
            endRowIndex:      lastRow,   // ajuste exacto al dato real
            startColumnIndex: 0,
            endColumnIndex:   lastCol
          }
        },
        fields: "range"
      }
    });
    Logger.log("    ↔ " + tableName + " → " + lastRow + " filas");
  });

  // ── 4. Ejecutar en un solo batchUpdate ──────────────────────────────────
  if (requests.length === 0) {
    Logger.log("  ℹ️  Sin tablas para sincronizar");
    return;
  }
  try {
    Sheets.Spreadsheets.batchUpdate({ requests: requests }, ssId);
    Logger.log("  ✅ " + requests.length + " tabla(s) sincronizada(s)");
  } catch (e) {
    Logger.log("  ❌ sincronizarRangosTablas_ error: " + e.message);
    throw e;
  }
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 6: TIPOS DE COLUMNA — resolución y aplicación
// ═════════════════════════════════════════════════════════════════

/**
 * Resuelve el tipo de columna para UNA columna específica.
 *
 * ORDEN DE RESOLUCIÓN (primera regla que aplica gana):
 *   1. Is*          → CHECKBOX   (auto por convención de nombre)
 *   2. *Date / *At  → DATE       (auto por convención de nombre)
 *   3. COLUMN_TYPES[tableName][colName].type === "DROPDOWN_INLINE"
 *                   → DROPDOWN   con valores hardcodeados
 *   4. COLUMN_TYPES[tableName][colName].type === "DROPDOWN_CAT"
 *                   → DROPDOWN   con valores del catalogCache
 *                      Si catalogCache === null: omitido (se aplica post-bootstrap)
 *                      Si valores vacíos en cache: omitido (catálogo no poblado aún)
 *   5. Default      → null       (TEXT — default de la API, no hace falta declarar)
 *
 * @param {string}      tableName    — nombre de la tabla (clave en COLUMN_TYPES)
 * @param {string}      colName      — nombre de la columna
 * @param {number}      colIndex     — índice 0-base de la columna en la tabla
 * @param {Object|null} catalogCache — mapa de valores de catálogo.
 *                                     null en setup → DROPDOWN_CAT omitidos.
 *                                     objeto en post-bootstrap → todos aplicados.
 * @returns {Object|null} columnProperties entry, o null si TEXT (default)
 */
function _resolverTipoColumna_(tableName, colName, colIndex, catalogCache) {
  // ── 1. Auto: Is* → CHECKBOX ─────────────────────────────────────────────
  if (/^Is[A-Z]/.test(colName)) {
    return { columnIndex: colIndex, columnName: colName, columnType: "CHECKBOX" };
  }

  // ── 2. Auto: *Date / *At → DATE ──────────────────────────────────────────
  if (/Date$|At$/.test(colName)) {
    return { columnIndex: colIndex, columnName: colName, columnType: "DATE" };
  }

  // ── 3 & 4. Consultar COLUMN_TYPES ───────────────────────────────────────
  const typeDef = (COLUMN_TYPES[tableName] || {})[colName];
  if (!typeDef) return null; // TEXT default

  if (typeDef.type === "DROPDOWN_INLINE") {
    return {
      columnIndex: colIndex,
      columnName:  colName,
      columnType:  "DROPDOWN",
      dataValidationRule: {
        condition: {
          type:   "ONE_OF_LIST",
          values: typeDef.values.map(function(v) { return { userEnteredValue: v }; })
        }
      }
    };
  }

  if (typeDef.type === "DROPDOWN_CAT") {
    if (!catalogCache) return null; // setup time — omitir, se aplica post-bootstrap

    const cacheKey = typeDef.statusType
      ? typeDef.source + ":" + typeDef.statusType
      : typeDef.source;
    const vals = catalogCache[cacheKey];
    if (!vals || vals.length === 0) return null; // catálogo vacío — omitir silenciosamente

    return {
      columnIndex: colIndex,
      columnName:  colName,
      columnType:  "DROPDOWN",
      dataValidationRule: {
        condition: {
          type:   "ONE_OF_LIST",
          values: vals.map(function(v) { return { userEnteredValue: v }; })
        }
      }
    };
  }

  return null; // tipo desconocido — TEXT default
}


/**
 * Construye el mapa de valores de catálogo leyendo los _CFG_* de coreSS.
 *
 * ESTRUCTURA DEL CACHE:
 *   "_CFG_PROGRAMS"          → ["CTB", "ADM", "TLC", "SIS", "MKT", "SST", "TRV"]
 *   "_CFG_COHORTS"           → ["EN26", "MR26", "MY26", ...]
 *   "_CFG_MOMENTS"           → ["C1M1", "C1M2", ..., "A1B1", ...]
 *   "_CFG_SUBJECTS"          → ["FUC", "APU", "NLV", ...]
 *   "_CFG_CAMPUSES"          → ["BOGOTA", ...]
 *   "_CFG_MODALITIES"        → ["DIR", "ART"]
 *   "_CFG_STATUSES:RISK"     → ["GREEN", "YELLOW", "RED"]
 *   "_CFG_STATUSES:ENROLLMENT" → ["ACTIVE", "COMPLETED", "FAILED", ...]
 *   ... (un entry por cada StatusType distinto)
 *
 * EFICIENCIA: una sola llamada getDataRange() por tabla — sin loops de celdas.
 * Solo incluye filas con IsActive = true (cuando la columna existe).
 *
 * @returns {Object} mapa { cacheKey: [valor1, valor2, ...] }
 */
function _construirCatalogCache_() {
  const coreSS = getSpreadsheetByName("core");
  const cache  = {};

  // ── Catálogos simples — clave = nombre de la hoja ────────────────────────
  const CATALOGS_SIMPLES = [
    { sheet: "_CFG_PROGRAMS",   codeCol: "ProgramCode"  },
    { sheet: "_CFG_MODALITIES", codeCol: "ModalityCode" },
    { sheet: "_CFG_MOMENTS",    codeCol: "MomentCode"   },
    { sheet: "_CFG_COHORTS",    codeCol: "CohortCode"   },
    { sheet: "_CFG_SUBJECTS",   codeCol: "SubjectCode"  },
    { sheet: "_CFG_CAMPUSES",   codeCol: "CampusCode"   }
  ];

  CATALOGS_SIMPLES.forEach(function(cat) {
    const hoja = coreSS.getSheetByName(cat.sheet);
    if (!hoja || hoja.getLastRow() < 2) {
      Logger.log("    ⚠️  Catálogo vacío: " + cat.sheet);
      return;
    }
    const data    = hoja.getDataRange().getValues();
    const head    = data[0];
    const iCode   = head.indexOf(cat.codeCol);
    const iActive = head.indexOf("IsActive");
    if (iCode === -1) return;

    cache[cat.sheet] = data.slice(1)
      .filter(function(r) { return iActive === -1 || r[iActive] === true; })
      .map(function(r)    { return String(r[iCode] || "").trim(); })
      .filter(function(v) { return v !== ""; });
  });

  // ── _CFG_STATUSES — agrupado por StatusType ──────────────────────────────
  const hojaStatuses = coreSS.getSheetByName("_CFG_STATUSES");
  if (hojaStatuses && hojaStatuses.getLastRow() > 1) {
    const data    = hojaStatuses.getDataRange().getValues();
    const head    = data[0];
    const iCode   = head.indexOf("StatusCode");
    const iType   = head.indexOf("StatusType");
    const iActive = head.indexOf("IsActive");

    data.slice(1).forEach(function(r) {
      if (iActive !== -1 && r[iActive] !== true) return;
      const code = String(r[iCode] || "").trim();
      const type = String(r[iType] || "").trim();
      if (!code || !type) return;
      const key = "_CFG_STATUSES:" + type;
      if (!cache[key]) cache[key] = [];
      cache[key].push(code);
    });
  }

  Logger.log("  📦 catalogCache: " + Object.keys(cache).length + " catálogos cargados");
  return cache;
}


/**
 * Aplica tipos de columna completos (CHECKBOX + DATE + DROPDOWN_INLINE + DROPDOWN_CAT)
 * a todas las Tablas nativas de un Spreadsheet.
 *
 * CUÁNDO LLAMAR:
 *   Después de poblarConfiguraciones() — los catálogos deben estar poblados
 *   para que los DROPDOWN_CAT tengan valores que mostrar.
 *   Se puede re-ejecutar en cualquier momento (idempotente — reemplaza
 *   columnProperties completas, no acumula).
 *
 * DIFERENCIA CON _buildAddTableRequest_():
 *   _buildAddTableRequest_() aplica solo CHECKBOX + DATE + DROPDOWN_INLINE
 *   (tipos conocidos en tiempo de setup, sin necesidad de catálogos).
 *   Esta función aplica TODOS los tipos, incluyendo DROPDOWN_CAT que
 *   requieren leer los valores de las tablas _CFG_*.
 *
 * GENÉRICA: acepta cualquier Spreadsheet del ecosistema.
 *   Se puede llamar sobre CORE, ADMIN y BI por separado o en loop.
 *   El orquestador (99_orquestador.gs) llama a aplicarTiposPostBootstrap()
 *   en 12c_operacionesCatalogos.gs que itera los tres SS.
 *
 * @param {Spreadsheet} ss     — Spreadsheet destino (CORE, ADMIN o BI)
 * @param {Object}      tables — objeto de tablas correspondiente (*_TABLES)
 */
function aplicarDropdownsCatalogo(ss, tables) {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔤 aplicarDropdownsCatalogo: " + ss.getName());
  Logger.log("════════════════════════════════════════════════");
  const ssId = ss.getId();

  // ── 1. Cargar catálogos ──────────────────────────────────────────────────
  const catalogCache = _construirCatalogCache_();

  // ── 2. Leer tableIds actuales del SS ─────────────────────────────────────
  let ssData;
  try {
    ssData = Sheets.Spreadsheets.get(ssId, { includeGridData: false });
  } catch (e) {
    Logger.log("  ⚠️  No se pudo leer el SS: " + e.message);
    return;
  }

  const tableMeta = {};
  ssData.sheets.forEach(function(s) {
    tableMeta[s.properties.title] = {
      tableId: (s.tables && s.tables.length > 0) ? s.tables[0].tableId : null
    };
  });

  // ── 3. Construir requests updateTable ────────────────────────────────────
  const requests = [];
  Object.keys(tables).forEach(function(tableName) {
    const cols = tables[tableName];
    const meta = tableMeta[tableName];

    if (!meta || !meta.tableId) {
      Logger.log("    ⚠️  Sin tabla registrada: " + tableName);
      return;
    }

    // Resolver TODOS los tipos (auto + inline + catalog)
    const columnProperties = [];
    cols.forEach(function(colName, i) {
      const prop = _resolverTipoColumna_(tableName, colName, i, catalogCache);
      if (prop) columnProperties.push(prop);
    });

    if (columnProperties.length === 0) {
      Logger.log("    ⏭  Sin tipos a aplicar: " + tableName);
      return;
    }

    requests.push({
      updateTable: {
        table: {
          tableId:          meta.tableId,
          columnProperties: columnProperties
        },
        fields: "columnProperties"
      }
    });

    const cats = columnProperties.filter(function(p) { return p.columnType === "DROPDOWN" && p.dataValidationRule; }).length;
    const autos = columnProperties.length - cats;
    Logger.log("    ✔ " + tableName + " → " + columnProperties.length +
               " tipos (" + autos + " auto + " + cats + " dropdown)");
  });

  // ── 4. Ejecutar en un solo batchUpdate ───────────────────────────────────
  if (requests.length === 0) {
    Logger.log("  ℹ️  Sin tablas para actualizar");
    return;
  }
  try {
    Sheets.Spreadsheets.batchUpdate({ requests: requests }, ssId);
    Logger.log("  ✅ " + requests.length + " tabla(s) tipadas en " + ss.getName());
  } catch (e) {
    Logger.log("  ❌ aplicarDropdownsCatalogo error: " + e.message);
    throw e;
  }
}