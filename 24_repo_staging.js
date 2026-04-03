/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 24_repo_staging.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Acceso a datos del spreadsheet SIDEP_04_STAGING_SETUP.
 *   CERO reglas de negocio.
 * ============================================================
 */

function leerStgInstitutionSetup(options) {
  const opts          = options || {};
  const requireStatus = opts.stageStatus || null;
  const mem           = getTableData("staging", "STG_INSTITUTION_SETUP");

  const datos = mem.datos.filter(function(row) {
    if (!requireStatus) return true;
    return String(row[mem.idx["StageStatus"]] || "").trim() === requireStatus;
  });

  return {
    ss: mem.ss,
    hoja: mem.hoja,
    encabezado: mem.encabezado,
    idx: mem.idx,
    datos: datos
  };
}


function leerStgInstitutionSetupPendientes() {
  return leerStgInstitutionSetup();
}


function actualizarStgInstitutionSetup(stageInstitutionId, patch) {
  const mem = getTableData("staging", "STG_INSTITUTION_SETUP");
  const iId = mem.idx["StageInstitutionID"];
  const id  = String(stageInstitutionId || "").trim();

  if (!id) {
    throw new Error("actualizarStgInstitutionSetup: StageInstitutionID es obligatorio.");
  }

  const rowIdx = mem.datos.findIndex(function(row) {
    return String(row[iId] || "").trim() === id;
  });

  if (rowIdx === -1) {
    throw new Error("actualizarStgInstitutionSetup: StageInstitutionID no encontrado → " + id);
  }

  Object.keys(patch || {}).forEach(function(key) {
    if (typeof mem.idx[key] === "undefined") return;
    mem.datos[rowIdx][mem.idx[key]] = patch[key];
  });

  _escribirEnBatch_(mem.hoja, mem);
  return mem.datos[rowIdx];
}


function registrarStagingSetupLog(entry) {
  const mem      = getTableData("staging", "STG_SETUP_LOG");
  const ahora    = nowSIDEP();
  const ejecutor = Session.getEffectiveUser().getEmail();
  const data     = entry || {};

  mem.datos.push([
    data.stageLogId     || uuid("stglog"),
    data.stageEntityType || "INSTITUTION",
    data.stageRecordId  || "",
    data.action         || "PROCESS",
    data.result         || "SUCCESS",
    data.message        || "",
    data.loggedAt       || ahora,
    data.loggedBy       || ejecutor
  ]);

  _escribirEnBatch_(mem.hoja, mem);
}
