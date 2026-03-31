/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: SIDEP_validarEsquema.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Diagnóstico de drift entre el modelo de datos definido en
 *   01_SIDEP_TABLES.gs y el estado real de los Spreadsheets en Drive.
 *   Solo lectura — no modifica ningún dato.
 *
 * CUÁNDO EJECUTAR:
 *   - Antes de cualquier script de onboarding para verificar estado limpio.
 *   - Después de ediciones manuales en Sheets para detectar inconsistencias.
 *   - Como auditoría periódica tras cambios de modelVersion.
 *
 * FUNCIONES PÚBLICAS:
 *   validarEsquema()              → diagnóstico completo de los 3 Spreadsheets
 *   validarTabla(fileKey, name)   → diagnóstico de una tabla específica
 *
 * SALIDA (Logger.log):
 *   ✅ OK       — columnas exactas, en orden correcto
 *   ⚠️  WARN    — columnas extra en Sheets que no están en el modelo
 *   ❌ ERROR    — columnas faltantes o en orden incorrecto
 *   ❌ AUSENTE  — la hoja entera no existe en el Spreadsheet
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs → SIDEP_CONFIG
 *   01_SIDEP_TABLES.gs → CORE_TABLES, ADMIN_TABLES, BI_TABLES
 *   02_SIDEP_HELPERS.gs → getSpreadsheetByName()
 *
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-31
 * ============================================================
 */


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 1: DIAGNÓSTICO COMPLETO
// ═════════════════════════════════════════════════════════════════

/**
 * Compara CORE_TABLES, ADMIN_TABLES y BI_TABLES contra el estado real
 * de los 3 Spreadsheets del ecosistema e imprime el reporte en el Logger.
 *
 * Ejecutar desde el Editor de Apps Script: Ejecutar → validarEsquema
 */
function validarEsquema() {
  Logger.log("════════════════════════════════════════════════════════════");
  Logger.log("🔍 SIDEP — VALIDACIÓN DE ESQUEMA  v" + SIDEP_CONFIG.modelVersion);
  Logger.log("════════════════════════════════════════════════════════════");

  const specs = [
    { fileKey: "core",  tables: CORE_TABLES,  label: "CORE  (SIDEP_01_CORE_ACADEMICO)" },
    { fileKey: "admin", tables: ADMIN_TABLES, label: "ADMIN (SIDEP_02_GESTION_ADMIN)"  },
    { fileKey: "bi",    tables: BI_TABLES,    label: "BI    (SIDEP_03_BI_DASHBOARD)"   }
  ];

  let totalOk = 0, totalWarn = 0, totalError = 0;

  specs.forEach(function(spec) {
    Logger.log("\n── " + spec.label + " ───────────────────────────────────────");

    let ss;
    try {
      ss = getSpreadsheetByName(spec.fileKey);
    } catch (e) {
      Logger.log("  ❌ SPREADSHEET NO ENCONTRADO: " + e.message);
      totalError += Object.keys(spec.tables).length;
      return;
    }

    Object.keys(spec.tables).forEach(function(tableName) {
      const r = _validarTabla_(ss, tableName, spec.tables[tableName]);

      if (r.estado === "OK") {
        Logger.log("  ✅ " + tableName + " — " + r.colsModelo + " columnas OK");
        totalOk++;

      } else if (r.estado === "WARN") {
        Logger.log("  ⚠️  " + tableName + " — columna(s) extra en Sheets (no en modelo):");
        r.extra.forEach(function(c) { Logger.log("       + " + c); });
        totalWarn++;

      } else if (r.estado === "AUSENTE") {
        Logger.log("  ❌ " + tableName + " — HOJA NO EXISTE en el Spreadsheet");
        totalError++;

      } else { // ERROR
        Logger.log("  ❌ " + tableName + " —" +
          (r.faltantes.length  > 0 ? " FALTAN " + r.faltantes.length + " col(s)" : "") +
          (r.ordenIncorrecto       ? " | ORDEN INCORRECTO"                         : "") +
          (r.extra.length     > 0 ? " | " + r.extra.length + " extra(s)"          : "")
        );
        if (r.faltantes.length > 0) {
          Logger.log("     Faltan  : " + r.faltantes.join(", "));
        }
        if (r.extra.length > 0) {
          Logger.log("     Extras  : " + r.extra.join(", "));
        }
        if (r.ordenIncorrecto) {
          Logger.log("     Modelo  : " + r.colsModeloComun.join(" | "));
          Logger.log("     Actual  : " + r.colsActualComun.join(" | "));
        }
        totalError++;
      }
    });
  });

  // ── Resumen final ──────────────────────────────────────────────────────────
  Logger.log("\n════════════════════════════════════════════════════════════");
  Logger.log("📊 RESUMEN: ✅ " + totalOk + " OK  |  ⚠️  " + totalWarn + " WARN  |  ❌ " + totalError + " ERROR");
  Logger.log("════════════════════════════════════════════════════════════");

  if (totalError === 0 && totalWarn === 0) {
    Logger.log("✅ Esquema completamente alineado con el modelo v" + SIDEP_CONFIG.modelVersion);
  } else {
    if (totalError > 0) {
      Logger.log("❌ Hay drift entre el modelo y los Sheets.");
      Logger.log("   → Hojas ausentes o con columnas faltantes: ejecutar setupSidepTables()");
      Logger.log("   → Columnas renombradas: corregir manualmente + actualizar modelVersion");
    }
    if (totalWarn > 0) {
      Logger.log("⚠️  Columnas extra detectadas — pueden ser adiciones manuales no registradas.");
      Logger.log("   → Si son intencionales: agregarlas a 01_SIDEP_TABLES.gs + actualizar modelVersion");
    }
  }
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 2: DIAGNÓSTICO DE TABLA INDIVIDUAL
// ═════════════════════════════════════════════════════════════════

/**
 * Diagnóstico puntual de una tabla específica — útil para debugging.
 *
 * Ejemplo:
 *   validarTabla("core", "MasterDeployments")
 *   validarTabla("admin", "Students")
 *
 * @param {string} fileKey   — "core" | "admin" | "bi"
 * @param {string} tableName — nombre de la tabla a validar
 */
function validarTabla(fileKey, tableName) {
  Logger.log("════════════════════════════════════════════════════════════");
  Logger.log("🔍 SIDEP — Validando: [" + fileKey + "] " + tableName);
  Logger.log("════════════════════════════════════════════════════════════");

  const tablesMap = { core: CORE_TABLES, admin: ADMIN_TABLES, bi: BI_TABLES };
  const tables    = tablesMap[fileKey];

  if (!tables) {
    Logger.log("❌ fileKey inválido: '" + fileKey + "'. Usar: core | admin | bi");
    return;
  }
  if (!tables[tableName]) {
    Logger.log("❌ '" + tableName + "' no está definida en el modelo para '" + fileKey + "'.");
    Logger.log("   Tablas disponibles: " + Object.keys(tables).join(", "));
    return;
  }

  let ss;
  try {
    ss = getSpreadsheetByName(fileKey);
  } catch (e) {
    Logger.log("❌ Spreadsheet no encontrado: " + e.message);
    return;
  }

  const r = _validarTabla_(ss, tableName, tables[tableName]);

  Logger.log("  Modelo  : " + r.colsModelo + " columnas");
  Logger.log("  Actual  : " + r.colsActual + " columnas");

  if (r.estado === "AUSENTE") {
    Logger.log("  ❌ La hoja '" + tableName + "' NO EXISTE en el Spreadsheet.");
    Logger.log("     → Ejecuta setupSidepTables() para crearla.");
    return;
  }

  if (r.faltantes.length > 0) {
    Logger.log("  ❌ Columnas en modelo pero AUSENTES en Sheets (" + r.faltantes.length + "):");
    r.faltantes.forEach(function(c) { Logger.log("       - " + c); });
  }

  if (r.extra.length > 0) {
    Logger.log("  ⚠️  Columnas en Sheets pero NO en modelo (" + r.extra.length + "):");
    r.extra.forEach(function(c) { Logger.log("       + " + c); });
  }

  if (r.ordenIncorrecto) {
    Logger.log("  ⚠️  Orden de columnas comunes difiere:");
    Logger.log("       Modelo : " + r.colsModeloComun.join(" | "));
    Logger.log("       Actual : " + r.colsActualComun.join(" | "));
  }

  if (r.estado === "OK") {
    Logger.log("  ✅ Esquema OK — " + r.colsModelo + " columnas alineadas perfectamente.");
  }
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 3: LÓGICA PRIVADA
// ═════════════════════════════════════════════════════════════════

/**
 * Compara el modelo de una tabla contra su hoja real en el Spreadsheet.
 *
 * @param {Spreadsheet} ss        — Spreadsheet destino
 * @param {string}      tableName — nombre de la tabla / hoja
 * @param {string[]}    modelCols — columnas esperadas (de *_TABLES en 01_SIDEP_TABLES.gs)
 * @returns {{
 *   estado:         "OK" | "WARN" | "ERROR" | "AUSENTE",
 *   colsModelo:     number,
 *   colsActual:     number,
 *   faltantes:      string[],
 *   extra:          string[],
 *   ordenIncorrecto: boolean,
 *   colsModeloComun: string[],
 *   colsActualComun: string[]
 * }}
 */
function _validarTabla_(ss, tableName, modelCols) {
  const hoja = ss.getSheetByName(tableName);
  if (!hoja) {
    return {
      estado:          "AUSENTE",
      colsModelo:      modelCols.length,
      colsActual:      0,
      faltantes:       modelCols.slice(),
      extra:           [],
      ordenIncorrecto: false,
      colsModeloComun: [],
      colsActualComun: []
    };
  }

  // Leer encabezado real — fila 1
  const lastCol   = hoja.getLastColumn();
  const actualCols = lastCol > 0
    ? hoja.getRange(1, 1, 1, lastCol).getValues()[0]
        .map(function(c) { return String(c).trim(); })
        .filter(function(c) { return c !== ""; })
    : [];

  // Calcular diferencias
  const modelSet  = {};
  modelCols.forEach(function(c) { modelSet[c]  = true; });
  const actualSet = {};
  actualCols.forEach(function(c) { actualSet[c] = true; });

  const faltantes = modelCols.filter(function(c)  { return !actualSet[c]; });
  const extra     = actualCols.filter(function(c) { return !modelSet[c];  });

  // Verificar orden solo en columnas comunes a ambos lados
  const colsModeloComun = modelCols.filter(function(c)  { return actualSet[c]; });
  const colsActualComun = actualCols.filter(function(c) { return modelSet[c];  });
  const ordenIncorrecto = colsModeloComun.join("|") !== colsActualComun.join("|");

  let estado;
  if (faltantes.length > 0 || ordenIncorrecto) {
    estado = "ERROR";
  } else if (extra.length > 0) {
    estado = "WARN";
  } else {
    estado = "OK";
  }

  return {
    estado:          estado,
    colsModelo:      modelCols.length,
    colsActual:      actualCols.length,
    faltantes:       faltantes,
    extra:           extra,
    ordenIncorrecto: ordenIncorrecto,
    colsModeloComun: colsModeloComun,
    colsActualComun: colsActualComun
  };
}
