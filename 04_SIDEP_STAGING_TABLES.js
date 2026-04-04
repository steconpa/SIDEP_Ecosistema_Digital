/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 04_SIDEP_STAGING_TABLES.gs
 * Versión: 1.2.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Definir los schemas de todas las tablas de staging.
 *   CERO lógica de negocio — solo estructuras de datos.
 *
 * PRINCIPIO ARQUITECTURAL:
 *   Ningún humano escribe directamente en las maestras.
 *   Todo dato entra por staging y el sistema promueve.
 *   Cada área de proceso tiene su propio spreadsheet de staging
 *   con columnas editables (staff) y columnas protegidas (sistema).
 *
 * SPREADSHEETS DE STAGING:
 *   SIDEP_04_STAGING_SETUP    (08_STAGING_SETUP/)
 *     STG_INSTITUTION_SETUP   → configuración institucional
 *     STG_SETUP_LOG           → auditoría de setup
 *
 *   SIDEP_STG_DOCENTES        (09_STAGING_ACADEMICO/)
 *     STG_DOCENTES            → datos de docentes a vincular
 *     STG_ASIGNACIONES        → asignaciones docente × aula
 *     STG_DOCENTES_LOG        → auditoría del procesamiento
 *
 * CONVENIOS DE COLUMNAS:
 *   Columnas editables por staff → sin prefijo especial (FirstName, Email...)
 *   Columnas de control (sistema) → prefijo Stage* o Target* o Processed*
 *   ApprovalStatus   → staff aprueba antes de que el sistema procese
 *   StageStatus      → sistema actualiza (PENDING→VALIDATED→PROMOTED|ERROR)
 *   ValidationMessage → sistema informa errores de validación
 *
 * CAMBIOS v1.2.0:
 *   + STAGING_ACADEMICO_TABLES: STG_DOCENTES, STG_ASIGNACIONES, STG_DOCENTES_LOG
 *   + STAGING_ACADEMICO_COLUMN_TYPES con dropdowns
 *   + STAGING_ACADEMICO_EDITABLE_COLUMNS con separación staff/sistema
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


// ============================================================
// STAGING ACADÉMICO — STG_DOCENTES / STG_ASIGNACIONES
// ============================================================

const STAGING_ACADEMICO_TABLES = {

  /**
   * STG_DOCENTES
   * Cargado por coordinación para vincular/actualizar docentes.
   * Columnas staff: FirstName … Notes + ApprovalStatus
   * Columnas sistema: Stage* / Target* / Processed*
   */
  "STG_DOCENTES": [
    "StageDocenteID",
    "RequestedAction",       // staff: REGISTER | UPDATE | DEACTIVATE
    "FirstName",
    "LastName",
    "Email",
    "Phone",
    "DocumentType",
    "DocumentNumber",
    "HireDate",
    "ContractType",
    "Notes",
    "ApprovalStatus",
    "StageStatus",
    "ValidationMessage",
    "TargetTeacherID",
    "RequestedBy",
    "RequestedAt",
    "ProcessedAt",
    "ProcessedBy"
  ],

  /**
   * STG_ASIGNACIONES
   * Cargado por coordinación para asignar docentes a aulas.
   * Llave natural: TeacherEmail × ProgramCode × SubjectCode × CohortCode × MomentCode
   */
  "STG_ASIGNACIONES": [
    "StageAsignacionID",
    "RequestedAction",       // staff: ASSIGN | REMOVE
    "TeacherEmail",
    "ProgramCode",
    "SubjectCode",
    "CohortCode",
    "MomentCode",
    "DayOfWeek",             // día de clase — fuente única para docentes y estudiantes
    "StartTime",             // hora inicio HH:mm
    "EndTime",               // hora fin   HH:mm
    "WeeklyHours",
    "StartDate",
    "EndDate",
    "Notes",
    "ApprovalStatus",
    "StageStatus",
    "ValidationMessage",
    "TargetAssignmentID",
    "RequestedBy",
    "RequestedAt",
    "ProcessedAt",
    "ProcessedBy"
  ],

  /**
   * STG_DOCENTES_LOG
   * Escritura exclusiva del sistema. Sin filas editables por staff.
   */
  "STG_DOCENTES_LOG": [
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


const STAGING_ACADEMICO_COLUMN_TYPES = {

  "STG_DOCENTES": {
    "RequestedAction": { type: "DROPDOWN_INLINE", values: ["REGISTER", "UPDATE", "DEACTIVATE"] },
    "DocumentType":    { type: "DROPDOWN_INLINE", values: ["CC", "CE", "PA", "NIT", "OTRO"] },
    "ContractType":    { type: "DROPDOWN_INLINE", values: ["PLANTA", "CONTRATISTA", "HORA_CATEDRA"] },
    "ApprovalStatus":  { type: "DROPDOWN_INLINE", values: ["SUBMITTED", "APPROVED", "REJECTED"] },
    "StageStatus":     { type: "DROPDOWN_INLINE", values: ["PENDING", "VALIDATED", "PROMOTED", "ERROR"] }
  },

  "STG_ASIGNACIONES": {
    "RequestedAction": { type: "DROPDOWN_INLINE", values: ["ASSIGN", "REMOVE"] },
    // Campos de lookup — listan valores activos de las tablas maestras
    "TeacherEmail": { type: "DROPDOWN_CAT",    source: "Teachers" },
    "ProgramCode":  { type: "DROPDOWN_CAT",    source: "_CFG_PROGRAMS" },
    "SubjectCode":  { type: "DROPDOWN_CAT",    source: "_CFG_SUBJECTS" },
    "CohortCode":   { type: "DROPDOWN_CAT",    source: "_CFG_COHORTS" },
    "MomentCode":   { type: "DROPDOWN_CAT",    source: "_CFG_MOMENTS" },
    // Horario
    "DayOfWeek":    { type: "DROPDOWN_INLINE", values: ["LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES", "SABADO"] },
    // Campos de control
    "ApprovalStatus": { type: "DROPDOWN_INLINE", values: ["SUBMITTED", "APPROVED", "REJECTED"] },
    "StageStatus":    { type: "DROPDOWN_INLINE", values: ["PENDING", "VALIDATED", "PROMOTED", "ERROR"] }
  },

  "STG_DOCENTES_LOG": {
    "StageEntityType": { type: "DROPDOWN_INLINE", values: ["DOCENTE", "ASIGNACION"] },
    "Action":          { type: "DROPDOWN_INLINE", values: ["VALIDATE", "PROMOTE", "INVITE", "RETRY", "CLEAN"] },
    "Result":          { type: "DROPDOWN_INLINE", values: ["SUCCESS", "ERROR", "PARTIAL", "SKIPPED"] }
  }
};


const STAGING_ACADEMICO_EDITABLE_COLUMNS = {
  "STG_DOCENTES": [
    "RequestedAction",
    "FirstName",
    "LastName",
    "Email",
    "Phone",
    "DocumentType",
    "DocumentNumber",
    "HireDate",
    "ContractType",
    "Notes",
    "ApprovalStatus"
  ],
  "STG_ASIGNACIONES": [
    "RequestedAction",
    "TeacherEmail",
    "ProgramCode",
    "SubjectCode",
    "CohortCode",
    "MomentCode",
    "DayOfWeek",
    "StartTime",
    "EndTime",
    "WeeklyHours",
    "StartDate",
    "EndDate",
    "Notes",
    "ApprovalStatus"
  ],
  "STG_DOCENTES_LOG": []
};


// ============================================================
// COLUMNAS REQUERIDAS EN TABLAS MAESTRAS
// Usado por _validarFilaMaestra_() antes de cada INSERT/UPDATE.
// Si alguna de estas columnas queda vacía, el servicio rechaza
// la fila con ValidationMessage descriptivo — nunca escribe
// datos incompletos en las maestras.
// ============================================================

const MAESTRA_REQUIRED_COLS = {

  /**
   * Teachers (SIDEP_01_CORE_ACADEMICO)
   * CampusCode y TeacherStatusCode los pone el sistema —
   * también se validan para detectar bugs en el servicio.
   */
  "Teachers": [
    "TeacherID",
    "FirstName",
    "LastName",
    "Email",
    "DocumentType",
    "DocumentNumber",
    "CampusCode",
    "TeacherStatusCode",
    "CreatedAt",
    "CreatedBy"
  ],

  /**
   * TeacherAssignments (SIDEP_02_GESTION_ADMIN)
   */
  "TeacherAssignments": [
    "AssignmentID",
    "TeacherID",
    "DeploymentID",
    "CampusCode",
    "WeeklyHours",
    "DayOfWeek",
    "StartTime",
    "EndTime",
    "IsActive",
    "CreatedAt",
    "CreatedBy"
  ]
};
