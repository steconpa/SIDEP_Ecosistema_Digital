/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 41_staging_setup_menu.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Menú y trigger de apertura para SIDEP_04_STAGING_SETUP.
 * ============================================================
 */

function stagingSetupOnOpen(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getName() !== SIDEP_CONFIG.files.staging) return;

  SpreadsheetApp.getUi()
    .createMenu("SIDEP Setup")
    .addItem("Validar Solicitudes Institucion", "validarSolicitudesInstitucionSetup")
    .addItem("Procesar Solicitudes Institucion", "procesarSolicitudesInstitucionSetup")
    .addSeparator()
    .addItem("Limpiar Mensajes", "limpiarMensajesInstitucionSetup")
    .addToUi();
}


function instalarTriggerAperturaStagingSetup_(ss) {
  const targetId = ss.getId();
  const exists = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === "stagingSetupOnOpen" &&
           t.getTriggerSourceId && t.getTriggerSourceId() === targetId;
  });

  if (!exists) {
    ScriptApp.newTrigger("stagingSetupOnOpen")
      .forSpreadsheet(ss)
      .onOpen()
      .create();
  }
}
