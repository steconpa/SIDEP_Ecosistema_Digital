/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 19_setupStagingSheets.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Crear y tipar las hojas/tablas de staging sin tocar las tablas
 *   maestras actuales del ecosistema.
 *
 * USO:
 *   setupStagingSheets()               → SAFE
 *   setupStagingSheets({ force:true }) → recrea solo hojas staging
 *
 * PRINCIPIO:
 *   Staging debe poder instalarse como una capa adicional encima del
 *   backend actual. No reemplaza APERTURA_PLAN ni los flujos vigentes.
 * ============================================================
 */

function setupStagingSheets(options) {
  const opts      = options || {};
  const force     = opts.force === true;
  const stagingSS = getOrCreateStagingSpreadsheet_();
  const t0        = Date.now();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🧱 SIDEP — setupStagingSheets");
  Logger.log("   Modo : " + (force ? "FORCE" : "SAFE"));
  Logger.log("   Archivo : " + SIDEP_CONFIG.files.staging);
  Logger.log("   Carpeta : " + SIDEP_CONFIG.stagingFolderName);
  Logger.log("════════════════════════════════════════════════");

  Logger.log("\n🏛️  Asegurando _CFG_INSTITUTION en CORE...");
  ensureInstitutionCoreTable_();

  configurarTablasStaging_(stagingSS, STAGING_SETUP_TABLES, force);

  Logger.log("\n🗂️  Registrando Tablas nativas de staging...");
  registrarTablasSheetsAPI_(stagingSS, STAGING_SETUP_TABLES, force);

  Logger.log("\n🔤 Aplicando dropdowns/tipos a staging...");
  aplicarDropdownsCatalogo(stagingSS, STAGING_SETUP_TABLES);

  Logger.log("\n🔒 Aplicando protecciones de columnas...");
  aplicarProteccionesStagingSetup_(stagingSS);

  Logger.log("\n🧭 Instalando trigger de menú al abrir...");
  instalarTriggerAperturaStagingSetup_(stagingSS);

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  Logger.log("\n════════════════════════════════════════════════");
  Logger.log("✅ setupStagingSheets completado en " + dur + "s");
  Logger.log("   Spreadsheet: " + stagingSS.getName());
  Logger.log("   Hojas       : " + Object.keys(STAGING_SETUP_TABLES).length);
  Logger.log("════════════════════════════════════════════════");
}


function configurarTablasStaging_(ss, tables, force) {
  const s = SIDEP_CONFIG.headerStyle;

  Object.keys(tables).forEach(function(nombre) {
    const cols  = tables[nombre];
    let hoja    = ss.getSheetByName(nombre);
    const nueva = !hoja;

    if (!hoja) hoja = ss.insertSheet(nombre);

    const tieneData = hoja.getLastRow() > 1;
    if (tieneData && !force) {
      hoja.getRange(1, 1, 1, cols.length).setValues([cols])
          .setBackground(s.background).setFontColor(s.fontColor).setFontWeight(s.fontWeight);
      Logger.log("  ⏭  Preservada: " + nombre);
    } else {
      hoja.clear();
      hoja.getRange(1, 1, 1, cols.length).setValues([cols])
          .setBackground(s.background).setFontColor(s.fontColor).setFontWeight(s.fontWeight);
      Logger.log("  ✔  [" + (nueva ? "Nueva" : force ? "Recreada" : "Vacía") + "] " + nombre);
    }

    hoja.setFrozenRows(1);
    hoja.autoResizeColumns(1, cols.length);
  });
}


function getOrCreateStagingSpreadsheet_() {
  const root = getRootFolderSafe();
  let stagingFolder;

  try {
    stagingFolder = getSubFolder(root, SIDEP_CONFIG.stagingFolderName);
  } catch (e) {
    stagingFolder = root.createFolder(SIDEP_CONFIG.stagingFolderName);
    Logger.log("  ➕ Carpeta staging creada: " + SIDEP_CONFIG.stagingFolderName);
  }

  return getOrCreateSpreadsheet(SIDEP_CONFIG.files.staging, stagingFolder);
}


function aplicarProteccionesStagingSetup_(ss) {
  Object.keys(STAGING_SETUP_TABLES).forEach(function(tableName) {
    const hoja = ss.getSheetByName(tableName);
    if (!hoja) return;

    const editable = STAGING_SETUP_EDITABLE_COLUMNS[tableName] || [];
    const headers  = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
    const currentUser = Session.getEffectiveUser().getEmail();

    // Limpiar protecciones previas de este setup para no acumularlas
    hoja.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function(p) {
      try {
        if (p.getDescription() && p.getDescription().indexOf("SIDEP_STAGING_SETUP:") === 0) {
          p.remove();
        }
      } catch (e) {}
    });

    if (tableName === "STG_SETUP_LOG") {
      protegerRangoStaging_(
        hoja.getRange(1, 1, Math.max(hoja.getMaxRows(), 2), hoja.getMaxColumns()),
        "SIDEP_STAGING_SETUP:FULL:" + tableName,
        currentUser
      );
      return;
    }

    headers.forEach(function(col, i) {
      const isEditable = editable.indexOf(String(col)) !== -1;
      const colRange   = hoja.getRange(1, i + 1, Math.max(hoja.getMaxRows(), 2), 1);

      if (isEditable) {
        hoja.getRange(1, i + 1).setBackground("#d9ead3");
      } else {
        hoja.getRange(1, i + 1).setBackground("#f4cccc");
        protegerRangoStaging_(
          colRange,
          "SIDEP_STAGING_SETUP:COL:" + tableName + ":" + col,
          currentUser
        );
      }
    });
  });
}


function protegerRangoStaging_(range, description, currentUser) {
  try {
    const p = range.protect();
    p.setDescription(description);
    p.setWarningOnly(false);
    const editors = p.getEditors();
    if (editors && editors.length > 0) {
      p.removeEditors(editors);
    }
    if (currentUser) {
      p.addEditor(currentUser);
    }
    if (p.canDomainEdit()) {
      p.setDomainEdit(false);
    }
  } catch (e) {
    Logger.log("  ⚠️  No se pudo proteger rango (" + description + "): " + e.message);
  }
}
