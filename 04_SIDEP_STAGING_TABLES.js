/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 04_SIDEP_STAGING_TABLES.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Definir las tablas del spreadsheet de staging setup institucional.
 *
 * OBJETIVO ARQUITECTURAL:
 *   - Setup del sistema separado de CRUD operativo.
 *   - Captura humana/AppSheet en staging.
 *   - Promoción controlada desde staging hacia maestras.
 *   - Portabilidad a otras instituciones sin hardcoding operativo.
 *
 * ALCANCE DE ESTA PRIMERA ENTREGA:
 *   - STG_INSTITUTION_SETUP → captura controlada de la institución
 *   - STG_SETUP_LOG         → auditoría técnica del procesamiento
 *
 * NOTA:
 *   Estas tablas NO están conectadas todavía al flujo productivo actual.
 *   Se crean aparte para introducir staging sin tocar las maestras vigentes.
 * ============================================================
 */

const STAGING_SETUP_TABLES = {

  "STG_INSTITUTION_SETUP": [
    "StageInstitutionID",
    "RequestedAction",
    "InstitutionLegalName",
    "InstitutionShortName",
    "TaxID",
    "Address",
    "ContactPhone",
    "EducationalDomain",
    "ContactEmail",
    "ApprovalStatus",
    "StageStatus",
    "ValidationMessage",
    "TargetInstitutionID",
    "Notes",
    "RequestedBy",
    "RequestedAt",
    "ProcessedAt",
    "ProcessedBy"
  ],

  "STG_SETUP_LOG": [
    "StageLogID",
    "StageEntityType",
    "StageRecordID",
    "Action",
    "Result",
    "Message",
    "LoggedAt",
    "LoggedBy"
  ]
};


const STAGING_COLUMN_TYPES = {

  "STG_INSTITUTION_SETUP": {
    "RequestedAction": { type: "DROPDOWN_INLINE", values: ["REGISTER", "UPDATE", "DEACTIVATE"] },
    "ApprovalStatus":  { type: "DROPDOWN_INLINE", values: ["SUBMITTED", "APPROVED", "REJECTED"] },
    "StageStatus":     { type: "DROPDOWN_INLINE", values: ["PENDING", "VALIDATED", "PROMOTED", "ERROR"] }
  },

  "STG_SETUP_LOG": {
    "StageEntityType": { type: "DROPDOWN_INLINE", values: ["INSTITUTION"] },
    "Action": { type: "DROPDOWN_INLINE", values: ["VALIDATE", "PROMOTE", "PROCESS", "CLEAN"] },
    "Result": { type: "DROPDOWN_INLINE", values: ["SUCCESS", "ERROR", "PARTIAL"] }
  }
};


const STAGING_SETUP_EDITABLE_COLUMNS = {
  "STG_INSTITUTION_SETUP": [
    "RequestedAction",
    "InstitutionLegalName",
    "InstitutionShortName",
    "TaxID",
    "Address",
    "ContactPhone",
    "EducationalDomain",
    "ContactEmail",
    "Notes"
  ],
  "STG_SETUP_LOG": []
};
