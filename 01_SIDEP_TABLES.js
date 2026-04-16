/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 01_SIDEP_TABLES.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Modelo de datos del sistema:
 *     1. Definición de tablas (*_TABLES) — columnas, sin datos.
 *     2. Constantes operativas compartidas (momentos, programas).
 *   NUNCA contiene configuración de sistema ni lógica de infraestructura.
 *
 * REGLA DE ORO — SRP por archivo:
 *   00_SIDEP_CONFIG.gs  → parámetros del sistema
 *   01_SIDEP_TABLES.gs  → modelo de datos (tablas + constantes)  ← este archivo
 *   02_SIDEP_HELPERS.gs → infraestructura reutilizable (Drive, Sheets, utils)
 *   12c_operacionesCatalogos.gs → lógica de negocio sobre catálogos
 *
 * CUÁNDO MODIFICAR ESTE ARCHIVO:
 *   - Agregar/quitar columnas de cualquier tabla → actualizar tabla aquí
 *                                                  + incrementar SIDEP_CONFIG.modelVersion
 *                                                  + re-ejecutar setupSidepTables()
 *   - Nuevo programa técnico  → agregar a PROGRAMAS_ESPECIFICOS / TODOS_LOS_PROGRAMAS
 *                               + agregar a _CFG_PROGRAMS
 *   - Nuevo momento académico → agregar a MOMENT_ORDER + MOMENTOS_DIR / MOMENTOS_ART
 *                               + agregar a _CFG_MOMENTS
 *
 * PATRÓN DE DISEÑO — datos estáticos vs dinámicos:
 *   Datos de negocio (matrículas, asistencia, riesgo) → Sheets (dinámico)
 *   Datos de modelo (qué momentos y programas existen) → aquí (estático)
 *   Las constantes de este archivo espejean las tablas _CFG_* en Sheets.
 *   Cualquier cambio aquí requiere actualizar el Sheet correspondiente también.
 *
 * VERSIÓN: 1.3.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-04-15
 *
 * CAMBIOS v1.3.0 vs v1.2.0 — Configuración dinámica de umbrales (modelo v4.4.0):
 *   - NUEVA tabla CORE: _CFG_SEMAFORO — umbrales y escala de calificación.
 *     Permite cambiar UMBRAL_GREEN, UMBRAL_YELLOW, ESCALA_MIN/MAX y niveles
 *     desde el Sheet sin tocar código. 20_semaforo.js la lee al arrancar.
 *     Si la tabla está vacía: fallback a CFG_SEMAFORO (constante en el script).
 *   - COLUMN_TYPES: entrada vacía _CFG_SEMAFORO (todos sus tipos son auto-detectados).
 *
 * CAMBIOS v1.2.0 vs v1.1.0 — Semáforo académico (modelo v4.3.0):
 *   - NUEVA columna _CFG_SUBJECTS.HasSyllabus (DROPDOWN_INLINE TRUE/FALSE).
 *     Identifica materias sin temario formal (DPW, PAI, SEM, MDA).
 *     Declarada en COLUMN_TYPES porque no sigue convención Is* (no auto-detectada).
 *   - NUEVA tabla ADMIN: GradeHistory — historial manual pre-Classroom.
 *     Una fila por estudiante × asignatura × momento. Fuente siempre = MANUAL.
 *     Política de calificación: escala 1.0–5.0 (DEC-2026-015).
 *   - NUEVA tabla BI: GradeAudit — tabla primaria del Semáforo (Opción B).
 *     ViewActiveStudents no cambia (resumen ejecutivo). GradeAudit contiene el
 *     detalle por asignatura: Nota, Nivel, SemaforoColor, PromedioAcumulado.
 *     Escrita/reemplazada por 20_semaforo.js en cada ejecución semanal.
 *   - COLUMN_TYPES: entradas nuevas para GradeHistory (ADMIN) y GradeAudit (BI).
 *
 * CAMBIOS v1.1.0 vs v1.0.0 — COLUMN_TYPES:
 *   - NUEVO const COLUMN_TYPES: mapa de tipos de columna por tabla.
 *     Fuente de verdad para _buildAddTableRequest_() y aplicarDropdownsCatalogo().
 *     Solo declara excepciones al default TEXT — columnas "Is*"/Date/At se
 *     detectan automáticamente por convención de nombre en 02_SIDEP_HELPERS.gs.
 *     Tipos:
 *       DROPDOWN_INLINE → lista fija corta hardcodeada (aplicable en setup)
 *       DROPDOWN_CAT    → valores vienen de tabla _CFG_* (requiere post-bootstrap)
 *     Las tablas _CFG_* de catálogo no se incluyen en COLUMN_TYPES porque
 *     sus propias columnas Code son la fuente de verdad, no referencias externas.
 *
 * CAMBIOS v1.0.0:
 *   - Extraído de 00_SIDEP_CONFIG.gs (Secciones 2, 3, 4 y 5) como parte
 *     del refactoring SRP v4.2.0. Sin cambios de schema respecto a v4.1.0.
 *   - var → const en todas las declaraciones.
 * ============================================================
 */


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 1: TABLAS — CORE (SIDEP_01_CORE_ACADEMICO)
// ═════════════════════════════════════════════════════════════════
// Solo columnas — SIN datos.
// Los datos van en 02_poblarConfiguraciones.gs y 12b_poblarAperturas.gs.

const CORE_TABLES = {

  "_CFG_MONTH_CODES": [
    "MonthID",       // TEXT — PK  (mon_01 … mon_12)
    "MonthCode",     // TEXT — EN, FB, MR, AB, MY, JN, JL, AG, SP, OC, NV, DC
                     // NOTA: SP = Septiembre (estándar del script)
                     //       JSONs del proyecto usan SE — unificar en Fase 2
    "MonthNumber",   // NUMBER — 1–12
    "MonthName",     // TEXT — Enero, Febrero…
    "IsActive"       // BOOLEAN
  ],

  "_CFG_COHORTS": [
    "CohortID",      // TEXT — PK
    "CohortCode",    // TEXT — EN26, MR26, SP26...
    "CohortName",    // TEXT — Enero 2026
    "AcademicYear",  // NUMBER
    "ModalityCode",  // TEXT — DIR / ART (ref _CFG_MODALITIES)
    "IsActive",      // BOOLEAN
    "StartDate",     // DATE
    "EndDate",       // DATE
    "CreatedAt",     // DATETIME
    "CreatedBy",     // TEXT (email)
    "UpdatedAt",     // DATETIME
    "UpdatedBy"      // TEXT (email)
  ],

  "_CFG_PROGRAMS": [
    "ProgramID",
    "ProgramCode",   // CTB, ADM, TLC, SIS, MKT, SST, TRV
    "ProgramName",
    "IsActive",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  "_CFG_MODALITIES": [
    "ModalityID",
    "ModalityCode",  // DIR (Directo ~14 meses) | ART (Articulado ~2 años)
    "ModalityName",
    "IsActive",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  "_CFG_MOMENTS": [
    "MomentID",
    "MomentCode",    // DIR: C1M1…C3M2  |  ART: A1B1…A2B4
    "MomentName",
    "MomentOrder",   // NUMBER — orden cronológico dentro de la modalidad
    "ModalityType",  // DIR | ART — separa los dos esquemas en AppSheet
    "IsActive",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Catálogo universal de estados — fuente de verdad para TODOS los estados del sistema.
  // StatusType agrupa los códigos por contexto de uso — para filtros en AppSheet.
  // StatusType válidos:
  //   DEPLOYMENT     → estados de creación de aulas: PENDING|CREATED|ERROR|ARCHIVED
  //   RISK           → semáforo académico: GREEN | YELLOW | RED
  //   ENROLLMENT     → estado de matrícula: ACTIVE|COMPLETED|FAILED|DROPPED|WITHDRAWN|PENDING_RETRY
  //   DEBT           → deuda académica: DEBT_PENDING | DEBT_IN_RETRY | DEBT_CLEARED
  //   CONTRACT       → tipo de contrato docente: HORA_CATEDRA | PLANTA
  //   PRIORITY       → prioridad de tareas: HIGH | MEDIUM | LOW
  //   TASK           → estado de tareas: TASK_PENDING | TASK_IN_PROGRESS | TASK_DONE
  //   INTERVENTION   → tipo de intervención: CALL | MEETING | EMAIL | ACADEMIC_SUPPORT
  //   TEACHER_STATUS → estado del docente: TEACHER_ACTIVE | TEACHER_INACTIVE | TEACHER_ON_LEAVE
  //   CONTACT_TYPE   → tipo de contacto: GUARDIAN | EMERGENCY | PARENT
  //   RECOGNITION_TYPE → convalidación (STUB Fase 2): CONVALIDACION|HOMOLOGACION|TRANSFERENCIA
  //   STRUCTURE      → estructura pedagógica: TOPICS_CREATED|FULL|STRUCTURE_ERROR|STRUCTURE_PENDING
  //   APERTURA       → v4.0.0 — estado de APERTURA_PLAN: PENDIENTE|CREADA|CANCELADA
  //   INVITATION     → v4.1.0 — invitación docente: TEACHER_INVITED|TEACHER_ACCEPTED|TEACHER_DECLINED
  "_CFG_STATUSES": [
    "StatusID",
    "StatusCode",    // ACTIVE, GREEN, FAILED, TEACHER_ACTIVE, TOPICS_CREATED, PENDIENTE...
    "StatusName",    // Descripción legible para humanos
    "StatusType",    // Contexto de uso — para filtros en AppSheet (ver lista arriba)
    "SortOrder",     // NUMBER — orden en dropdowns de AppSheet
    "IsActive",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  "_CFG_CAMPUSES": [
    "CampusID",
    "CampusCode",    // BOGOTA, MEDELLIN...
    "CampusName",
    "City",
    "IsActive",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  "_CFG_INSTITUTION": [
    "InstitutionID",
    "InstitutionCode",
    "InstitutionLegalName",
    "InstitutionShortName",
    "TaxID",
    "Address",
    "ContactPhone",
    "EducationalDomain",
    "ContactEmail",
    "Timezone",
    "IsActive",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Catálogo de materias — fuente de verdad para nomenclatura y datos de cada asignatura.
  //
  // CAMBIO v4.0.0 — DOS COLUMNAS NUEVAS + CAMBIO SEMÁNTICO EN CUATRO EXISTENTES:
  //   COLUMNAS NUEVAS: CicloDir (C1|C2|C3) y CicloArt (A1|A2) — informativas.
  //   Total columnas: 17 (v3.6.1) → 19 (v4.0.0).
  //   DirStartMoment, DirEndMoment, ArtStartBlock, ArtEndBlock: INFORMATIVOS en v4.0.
  //   El rol de control de apertura ahora lo cumple APERTURA_PLAN.
  //   14_crearAulas.gs NO los consulta para ninguna decisión de apertura.
  "_CFG_SUBJECTS": [
    "SubjectID",
    "SubjectCode",       // FUC, APU, NLV... — clave de nomenclatura de aulas
    "SubjectName",
    "ProgramCode",       // ref _CFG_PROGRAMS — TRV si es transversal a todos
    "CicloDir",          // v4.0 — C1 | C2 | C3 — ciclo sugerido DIR (informativo)
    "CicloArt",          // v4.0 — A1 | A2 — ciclo sugerido ART (informativo)
    "DirStartMoment",    // INFORMATIVO v4.0 — ref _CFG_MOMENTS (DIR)
    "DirEndMoment",      // INFORMATIVO v4.0 — = DirStartMoment si dura un solo momento
    "ArtStartBlock",     // INFORMATIVO v4.0 — ref _CFG_MOMENTS (ART)
    "ArtEndBlock",       // INFORMATIVO v4.0 — = ArtStartBlock si dura un solo bloque
    "Credits",
    "Hours",
    "IsTransversal",     // BOOLEAN — true = UNA sola aula compartida por todos los programas
    "IsActive",
    "Notes",
    "HasSyllabus",       // v4.3.0 — TRUE si tiene temario en _CFG_SYLLABUS, FALSE si es libre
                         // NOTA: no sigue convención Is* por claridad semántica — ver COLUMN_TYPES
                         // Materias sin syllabus conocidas: DPW, PAI, SEM, MDA
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Tabla de versiones — registro inmutable de cada deploy.
  // Cada ejecución de setupSidepTables() AGREGA una fila, nunca sobrescribe.
  "_SYS_VERSION": [
    "VersionID",       // TEXT — PK (ver_<timestamp_ms>)
    "VersionNumber",   // TEXT — 4.2.0
    "VersionLabel",    // TEXT — descripción del release
    "DeployedAt",      // DATETIME
    "DeployedBy",      // TEXT (email)
    "ScriptHash",      // TEXT — timestamp ms como identificador único de ejecución
    "TotalTables",     // NUMBER — total de hojas creadas en este deploy
    "Environment",     // TEXT — PRODUCTION | STAGING | TEST
    "Notes"
  ],

  // Registro de aulas creadas en Google Classroom.
  //
  // MODELO CONVEYOR BELT:
  //   CohortCode = VENTANA QUE ABRIÓ EL CLASSROOM (no cohorte de entrada del estudiante).
  //   El cohorte de ENTRADA vive en Students.CohortCode y Enrollments.EntryCohortCode.
  //
  // RELACIÓN CON APERTURA_PLAN (v4.0.0):
  //   Cuando 14_crearAulas.gs procesa una apertura:
  //     1. Genera fila PENDING aquí con el DeploymentID
  //     2. Actualiza APERTURA_PLAN: AperturaStatus=CREADA + DeploymentID
  //     3. crearAulas() llama Classroom API y marca CREATED
  "MasterDeployments": [
    "DeploymentID",
    "ProgramCode",            // ref _CFG_PROGRAMS
    "ModalityCode",           // ref _CFG_MODALITIES
    "CohortCode",             // ref _CFG_COHORTS — VENTANA QUE ABRIÓ EL CLASSROOM
    "MomentCode",             // ref _CFG_MOMENTS
    "SubjectCode",            // ref _CFG_SUBJECTS
    "GroupCode",              // 001 — para futura división de grupos grandes
    "SubjectName",
    "GeneratedNomenclature",  // CTB-DIR-MR26-C1M2-SPC-001 — clave de idempotencia
    "GeneratedClassroomName", // [CTB] Soportes Contables | C1M2 · MR26
    "ClassroomID",            // ID de Google Classroom — vacío hasta crearAulas()
    "ClassroomURL",           // URL del aula — vacío hasta crearAulas()
    "ScriptStatusCode",       // ref _CFG_STATUSES (DEPLOYMENT): PENDING|CREATED|ERROR|ARCHIVED
    "CampusCode",             // ref _CFG_CAMPUSES
    "CreatedAt",
    "CreatedBy",
    "Notes"
  ],

  // Estructura pedagógica de cada aula — una fila por semana × deployment.
  //
  // Fase 1: Topics vacíos — el docente llena contenido manualmente.
  // Fase 2: CourseWorkCount / MaterialCount / AssignmentIDs se populan
  //         al automatizar carga de actividades. Schema NO cambia.
  //
  // StructureStatusCode (StatusType=STRUCTURE):
  //   TOPICS_CREATED   → Topics creados, docente llena contenido (Fase 1)
  //   FULL             → Topics + CourseWork + Materials completos (Fase 2)
  //   STRUCTURE_ERROR  → Fallo en Classroom API — ver AssignmentIDs
  //   STRUCTURE_PENDING → Aún no procesado
  //
  // AssignmentIDs (uso dual):
  //   Fase 2: IDs de actividades separados por pipe.
  //   Fase 1 ERROR: almacena el mensaje de error.
  "DeploymentTopics": [
    "TopicRowID",            // TEXT — PK — "top_<uuid>"
    "DeploymentID",          // ref MasterDeployments
    "ClassroomCourseID",     // ClassroomID del aula — redundante, optimiza API calls
    "ClassroomTopicID",      // ID devuelto por Classroom.Courses.Topics.create()
    "SubjectCode",           // ref _CFG_SUBJECTS — redundante, optimiza queries BI
    "WeekNumber",            // NUMBER — 1, 2, 3...
    "TopicName",             // "Semana 1 · Introducción a la Contabilidad"
    "StructureStatusCode",   // ref _CFG_STATUSES (StatusType=STRUCTURE)
    // ── Campos Fase 2 (vacíos en Fase 1 — schema estable, NO eliminar) ──────
    "CourseWorkCount",       // NUMBER — tareas creadas en este topic (0 en Fase 1)
    "MaterialCount",         // NUMBER — materiales creados (0 en Fase 1)
    "AssignmentIDs",         // TEXT — IDs pipe-separated (Fase 2) | error msg (ERROR)
    // ── Trazabilidad ──────────────────────────────────────────────────────────
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Tabla de aperturas — decisiones de Carlos sobre qué abrir cada período.
  //
  // FLUJO DE ESTADOS (AperturaStatus — StatusType=APERTURA):
  //   PENDIENTE  → aprobada por Carlos, 14_crearAulas aún no la procesa
  //   CREADA     → 14_crearAulas generó la fila en MasterDeployments y creó el aula
  //   CANCELADA  → Carlos decidió no abrir — queda como auditoría permanente
  //
  // IDEMPOTENCIA: clave = CohortCode + MomentCode + SubjectCode + ProgramCode.
  // MATERIAS TRANSVERSALES: ProgramCode = 'TRV', una sola fila → una sola aula.
  "APERTURA_PLAN": [
    "AperturaID",       // TEXT — PK — "apr_<uuid>"
    "CohortCode",       // ref _CFG_COHORTS — ventana que ABRE el aula
    "MomentCode",       // ref _CFG_MOMENTS — momento académico de apertura
    "SubjectCode",      // ref _CFG_SUBJECTS — asignatura a abrir
    "ProgramCode",      // ref _CFG_PROGRAMS — TRV si es transversal
    "IsTransversal",    // BOOLEAN — true = una sola aula compartida por todos
    "AperturaStatus",   // PENDIENTE | CREADA | CANCELADA (StatusType=APERTURA)
    "DeploymentID",     // ref MasterDeployments — se llena cuando AperturaStatus=CREADA
    "PlannedBy",        // TEXT — email de quien registró la apertura
    "PlannedAt",        // DATETIME — cuándo se registró
    "Notes",            // TEXT — razón de excepción si no sigue la malla oficial
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Configuración dinámica del semáforo — v4.4.0.
  //
  // PROPÓSITO: permite ajustar umbrales y escala sin tocar código.
  // 20_semaforo.js lee esta tabla al arrancar y sobreescribe CFG_SEMAFORO
  // (constante en el script). Si la tabla está vacía, el script usa los
  // defaults hardcodeados como fallback — el sistema nunca queda roto.
  //
  // CLAVES DEFINIDAS (ConfigKey):
  //   ESCALA_MIN          → nota mínima válida         (default 1.0)
  //   ESCALA_MAX          → nota máxima válida         (default 5.0)
  //   UMBRAL_GREEN        → mínimo para semáforo VERDE (default 4.1)
  //   UMBRAL_YELLOW       → mínimo para AMARILLO       (default 3.0)
  //   UMBRAL_APROBACION   → nota mínima aprobatoria    (default 3.0)
  //   NIVEL_EXCELENTE_MIN → mínimo para nivel EXCELENTE (default 4.5)
  //   NIVEL_BUENO_MIN     → mínimo para nivel BUENO    (default 4.0)
  //
  // CÓMO CAMBIAR UN UMBRAL:
  //   1. Abrir SIDEP_01_CORE_ACADEMICO → hoja _CFG_SEMAFORO
  //   2. Editar ConfigValue de la clave correspondiente
  //   3. El próximo lunes el semáforo usará el valor nuevo automáticamente
  //
  // NO hay que tocar ningún script al cambiar umbrales.
  "_CFG_SEMAFORO": [
    "ConfigSemaforoID",  // TEXT — PK — "csf_<uuid>"
    "ConfigKey",         // TEXT — clave del parámetro (ver lista arriba)
    "ConfigValue",       // NUMBER — valor numérico del parámetro
    "ConfigLabel",       // TEXT — nombre legible para Carlos en AppSheet
    "Description",       // TEXT — qué controla este parámetro
    "IsActive",          // BOOLEAN — false = ignorado por el semáforo
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Calendario académico — cohorte × momento → fechas reales.
  // FUENTE DE VERDAD del calendario, usada por el Semáforo (20_semaforo.js).
  //
  // CohortCode aquí = cohorte de ENTRADA del estudiante.
  // (≠ CohortCode en MasterDeployments, que es la ventana del aula)
  //
  // IsFinalPeriod = true → script puede cerrar el cohorte automáticamente.
  "_CFG_COHORT_CALENDAR": [
    "CalendarID",       // cal_EN26_C1M1 | cal_MR26_C1M2
    "CohortCode",       // ref _CFG_COHORTS — cohorte de ENTRADA del estudiante
    "MomentCode",       // ref _CFG_MOMENTS
    "PeriodLabel",      // "C1 Momento 2" — etiqueta legible para AppSheet
    "StartDate",        // DATE
    "EndDate",          // DATE
    "WeeksEffective",   // NUMBER — semanas reales descontando recesos
    "IsFinalPeriod",    // BOOLEAN — true SOLO en el último período del programa
    "IsActive",         // BOOLEAN
    "Notes",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Recesos institucionales — el Semáforo congela estados durante recesos activos.
  // AppliesTo = ALL aplica a todos los cohortes activos.
  "_CFG_RECESSES": [
    "RecessID",
    "RecessName",
    "StartDate",
    "EndDate",
    "AppliesTo",     // ALL | EN26 | MR26... — a quién aplica el receso
    "IsActive",
    "Notes",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Entidad docente — FIX-36 v3.3.0.
  // Reemplaza strings sueltos TeacherName/TeacherEmail en TeacherAssignments.
  // TeacherStatusCode ref _CFG_STATUSES (StatusType=TEACHER_STATUS).
  "Teachers": [
    "TeacherID",          // TEXT — PK — Utilities.getUuid()
    "FirstName",
    "LastName",
    "Email",              // único — fuente de verdad del email del docente
    "Phone",
    "DocumentType",       // CC, CE, PAS
    "DocumentNumber",
    "CampusCode",         // ref _CFG_CAMPUSES — sede principal del docente
    "TeacherStatusCode",  // ref _CFG_STATUSES (StatusType=TEACHER_STATUS)
    "HireDate",           // DATE — para cálculo de antigüedad en Fase 2
    "Notes",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ]
};


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 2: TABLAS — ADMIN (SIDEP_02_GESTION_ADMIN)
// ═════════════════════════════════════════════════════════════════

const ADMIN_TABLES = {

  // Registro maestro de estudiantes.
  // CohortCode = cohorte de ENTRADA (EN26, MR26...) — INMUTABLE.
  "Students": [
    "StudentID",
    "DocumentType",         // CC, TI, CE
    "DocumentNumber",
    "StudentType",          // DIRECTO | ARTICULADO
    "FirstName",
    "LastName",
    "Phone",
    "Email",
    "CohortCode",           // ref _CFG_COHORTS — cohorte de ENTRADA — INMUTABLE
    "ProgramCode",          // ref _CFG_PROGRAMS
    "CampusCode",           // ref _CFG_CAMPUSES
    "StudentStatusCode",    // ref _CFG_STATUSES (StatusType=ENROLLMENT)
    "CompletionStatus",     // IN_PROGRESS | GRADUATED | DROPPED | EXTENDED | TRANSFERRED
    "GraduationDate",       // vacío hasta que se gradúa
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Matrículas individuales por deployment.
  //
  // EntryCohortCode = cohorte de ENTRADA del estudiante — INMUTABLE.
  // WindowCohortCode = ventana del AULA donde está matriculado.
  // Ejemplo: estudiante EN26 en aula MR26 → EntryCohortCode=EN26, WindowCohortCode=MR26.
  // AperturaID (v4.0.0): trazabilidad hacia APERTURA_PLAN. Vacío en Fase 1.
  "Enrollments": [
    "EnrollmentID",
    "StudentID",            // ref Students
    "DeploymentID",         // ref MasterDeployments
    "AperturaID",           // v4.0 — ref APERTURA_PLAN (trazabilidad) — vacío Fase 1
    "EntryCohortCode",      // ref _CFG_COHORTS — cohorte de ENTRADA — INMUTABLE
    "WindowCohortCode",     // ref _CFG_COHORTS — ventana del AULA
    "MomentCode",           // ref _CFG_MOMENTS
    "AttemptNumber",        // NUMBER — 1=primera vez, 2=reintento...
    "EnrollmentStatusCode", // ref _CFG_STATUSES (ENROLLMENT): ACTIVE|COMPLETED|FAILED|DROPPED|WITHDRAWN
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Deuda académica por asignatura — FIX-30 v3.2.9.
  // Flujo: DEBT_PENDING → DEBT_IN_RETRY → DEBT_CLEARED.
  "AcademicDebts": [
    "DebtID",                 // TEXT — PK (dbt_<uuid>)
    "StudentID",              // ref Students
    "SubjectCode",            // ref _CFG_SUBJECTS — asignatura reprobada
    "OriginalMoment",         // ref _CFG_MOMENTS — período donde debía cursarla
    "OriginalDeploymentID",   // ref MasterDeployments — aula donde la reprobó
    "RetryDeploymentID",      // ref MasterDeployments — aula de reintento (vacío hasta asignar)
    "DebtStatusCode",         // ref _CFG_STATUSES (StatusType=DEBT)
    "ClearedAt",              // DATE — fecha en que aprobó el reintento
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Semáforo académico — una fila por riesgo activo — FIX-31 v3.2.9.
  // IsActive = FALSE cuando se resuelve (historial permanente — nunca se borra).
  "RiskFlags": [
    "RiskID",
    "StudentID",            // ref Students
    "DeploymentID",         // ref MasterDeployments — aula que generó el riesgo
    "SubjectCode",          // ref _CFG_SUBJECTS — redundante, optimiza queries BI
    "EntryCohortCode",      // cohorte de entrada (para filtros AppSheet)
    "RiskStatusCode",       // ref _CFG_STATUSES (StatusType=RISK)
    "RiskCategory",         // ACADEMIC | ADMIN | ATTENDANCE
    "Description",
    "FlaggedAt",
    "FlaggedBy",
    "ResolvedAt",           // NULL si no resuelto
    "ResolvedBy",
    "IsActive"              // FALSE cuando se resuelve
  ],

  "Interventions": [
    "InterventionID",
    "RiskID",               // ref RiskFlags
    "StudentID",            // ref Students
    "InterventionTypeCode", // ref _CFG_STATUSES (StatusType=INTERVENTION)
    "Description",
    "Outcome",
    "IntervenedAt",
    "IntervenedBy",
    "FollowUpDate",
    "CreatedAt",
    "CreatedBy"
  ],

  // Asignaciones docentes — FIX-33 v3.2.9 + FIX-36 v3.3.0 + v4.1.0.
  //
  // MODELO DE INVITACIONES v4.1.0:
  //   Google Workspace sin admin no puede usar Teachers.create() directo.
  //   Se usa Classroom.Invitations.create() — el docente debe ACEPTAR.
  //   IsActive = false hasta que el docente acepta.
  //   InvitationStatus (StatusType=INVITATION): TEACHER_INVITED | TEACHER_ACCEPTED | TEACHER_DECLINED
  "TeacherAssignments": [
    "AssignmentID",
    "TeacherID",            // ref Teachers (CORE)
    "DeploymentID",         // ref MasterDeployments (CORE)
    "CampusCode",           // ref _CFG_CAMPUSES
    "WeeklyHours",
    "StartDate",
    "EndDate",
    "ContractTypeCode",     // ref _CFG_STATUSES (StatusType=CONTRACT)
    "IsActive",             // false hasta que docente acepta invitación
    "CreatedAt",
    "CreatedBy",
    "InvitationID",         // v4.1.0 — ID de Classroom.Invitations.create()
    "InvitationStatus",     // v4.1.0 — ref _CFG_STATUSES (StatusType=INVITATION)
    "DayOfWeek",            // v4.3.0 — día de clase: LUNES..SABADO
    "StartTime",            // v4.3.0 — hora inicio formato HH:mm (ej. "07:00")
    "EndTime"               // v4.3.0 — hora fin   formato HH:mm (ej. "09:00")
  ],

  // Contactos de estudiantes — FIX-37 v3.3.0.
  // OBLIGATORIO para articulados (menores de edad).
  "StudentContacts": [
    "ContactID",            // TEXT — PK — Utilities.getUuid()
    "StudentID",            // ref Students
    "ContactTypeCode",      // ref _CFG_STATUSES (StatusType=CONTACT_TYPE)
    "FirstName",
    "LastName",
    "Relationship",         // Madre, Padre, Tío, Acudiente... (texto libre)
    "Phone",
    "Email",
    "IsLegalGuardian",      // BOOLEAN — true = firma documentos oficiales
    "IsPrimaryContact",     // BOOLEAN — true = primer contacto a notificar
    "Notes",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // ── TABLAS STUB — Movilidad estudiantil (FIX-38 v3.3.0) ─────────────────────
  // Schema definitivo. Sin datos ni lógica activa en Fase 1.
  // Activar en Fase 2 sin migración de esquema.

  "ProgramTransfers": [
    "TransferID",           // TEXT — PK — Utilities.getUuid()
    "StudentID",
    "FromProgramCode",      // ref _CFG_PROGRAMS
    "ToProgramCode",        // ref _CFG_PROGRAMS
    "FromCohortCode",       // ref _CFG_COHORTS
    "ToCohortCode",         // ref _CFG_COHORTS
    "TransferMoment",       // ref _CFG_MOMENTS — desde dónde empieza en destino
    "TransferDate",
    "ApprovedBy",
    "Notes",
    "CreatedAt",
    "CreatedBy"
  ],

  "ModalityTransitions": [
    "TransitionID",         // TEXT — PK — Utilities.getUuid()
    "StudentID",
    "FromModalityCode",     // ART
    "ToModalityCode",       // DIR
    "ArtCohortCode",        // ref _CFG_COHORTS
    "DirCohortCode",        // ref _CFG_COHORTS
    "DirEntryMoment",       // ref _CFG_MOMENTS — punto de entrada al programa DIR
    "TransitionDate",
    "ApprovedBy",
    "Notes",
    "CreatedAt",
    "CreatedBy"
  ],

  "CreditRecognitions": [
    "RecognitionID",        // TEXT — PK — Utilities.getUuid()
    "StudentID",
    "SubjectCode",          // ref _CFG_SUBJECTS
    "OriginalModality",     // ART | DIR | EXTERNAL
    "OriginalDeploymentID", // ref MasterDeployments
    "RecognitionType",      // ref _CFG_STATUSES (StatusType=RECOGNITION_TYPE)
    "RelatedTransferID",    // ref ProgramTransfers
    "RelatedTransitionID",  // ref ModalityTransitions
    "ApprovedBy",
    "Notes",
    "CreatedAt",
    "CreatedBy"
  ],

  "AdminTasks": [
    "TaskID",
    "Category",
    "Description",
    "AssignedTo",
    "PriorityCode",         // ref _CFG_STATUSES (StatusType=PRIORITY)
    "TaskStatusCode",       // ref _CFG_STATUSES (StatusType=TASK)
    "DueDate",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  "AutomationLogs": [
    "LogID",
    "System",               // CLASSROOM | SHEETS | APPSHEET
    "Action",               // CREATE_COURSE | EXPORT_STUDENTS | RISK_SCAN...
    "Origin",               // nombre de función GAS que generó el log
    "Result",               // SUCCESS | ERROR | PARTIAL
    "RecordsProcessed",
    "ErrorMessage",         // NULL si exitoso
    "ExecutedAt",
    "ExecutedBy"
  ],

  // Temario semanal — FIX v3.4.0.
  // 05_estructurarAulas.gs lee esta tabla para generar TopicName: "Semana {N} · {WeekTitle}"
  "_CFG_SYLLABUS": [
    "SyllabusID",           // syl_FUC_W01 | syl_FUC_W02...
    "SubjectCode",          // ref _CFG_SUBJECTS
    "WeekNumber",           // NUMBER — 1..8 (o 1..16 para PRL)
    "WeekTitle",            // "Introducción a la Contabilidad"
    "Contents",             // Contenidos clave separados por " | "
    "Activity",             // Actividad principal de la semana
    "Product",              // Entregable del estudiante
    "Status",               // COMPLETO | PENDIENTE
    "CreatedAt",
    "CreatedBy"
  ],

  // Historial de calificaciones pre-Classroom — v4.3.0 (Semáforo).
  //
  // PROPÓSITO: almacena las notas de estudiantes de cohortes históricos (EN26, FB25, AG25)
  // que cursaron períodos antes de que existiera Google Classroom.
  // Fuente: planilla Excel manual → importación única por periodo.
  //
  // POLÍTICA DE CALIFICACIÓN (DEC-2026-015 — escala institucional):
  //   Nota válida: 1.0–5.0
  //   Estado: APROBADO si Nota ≥ 3.0 | REPROBADO si Nota < 3.0
  //   Nivel:  INSUFICIENTE (1.0–2.9) | ACEPTABLE (3.0–3.9) | BUENO (4.0–4.4) | EXCELENTE (4.5–5.0)
  //
  // RELACIÓN CON EL SEMÁFORO (20_semaforo.js):
  //   El motor lee GradeHistory para calcular PromedioAcumulado en GradeAudit.
  //   Fuente siempre = MANUAL para filas de esta tabla.
  //   Una sola fila por estudiante × asignatura × momento (idempotencia: StudentID+SubjectCode+MomentCode).
  "GradeHistory": [
    "GradeHistoryID",    // TEXT — PK — "ghi_<uuid>"
    "StudentID",         // ref Students (ADMIN)
    "SubjectCode",       // ref _CFG_SUBJECTS (CORE)
    "SubjectName",       // TEXT — desnormalizado, optimiza consultas BI sin JOIN
    "ProgramCode",       // ref _CFG_PROGRAMS (CORE)
    "EntryCohortCode",   // ref _CFG_COHORTS — cohorte de ENTRADA del estudiante — INMUTABLE
    "WindowCohortCode",  // ref _CFG_COHORTS — ventana del aula donde cursó la materia
    "MomentCode",        // ref _CFG_MOMENTS — período académico (C1M1, A1B1...)
    "Nota",              // NUMBER — 1.0–5.0 — nota final de la asignatura
    "Nivel",             // INSUFICIENTE | ACEPTABLE | BUENO | EXCELENTE
    "Estado",            // APROBADO (Nota ≥ 3.0) | REPROBADO (Nota < 3.0)
    "Fuente",            // MANUAL siempre — distingue del flujo Classroom
    "CreatedAt",
    "CreatedBy"
  ]
};


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 3: TABLAS — BI (SIDEP_03_BI_DASHBOARD)
// ═════════════════════════════════════════════════════════════════

const BI_TABLES = {

  // Vista agregada de estudiantes activos — refrescada por el Semáforo semanal.
  "ViewActiveStudents": [
    "StudentID",
    "FullName",
    "EntryCohortCode",
    "ProgramCode",
    "CampusCode",
    "EnrollmentStatusCode",
    "ActiveRiskStatusCode",
    "OpenInterventions",    // NUMBER — intervenciones activas sin resolver
    "PendingDebts",         // NUMBER — asignaturas con deuda activa
    "GeneratedAt"           // DATETIME — timestamp del último refresh del Semáforo
  ],

  // Métricas operacionales mensuales — alimenta el Dashboard Ejecutivo de Carlos.
  "ViewOperationalMetrics": [
    "ReportMonth",
    "CampusCode",
    "TotalActiveStudents",
    "TotalCoursesCreated",
    "RedRiskCount",
    "YellowRiskCount",
    "GreenRiskCount",
    "TotalPendingDebts",
    "AdminTasksPending",
    "AutomationsRun",
    "GeneratedAt"
  ],

  // Auditoría de calificaciones — tabla primaria del Semáforo — v4.3.0.
  //
  // PROPÓSITO: una fila por estudiante × asignatura × momento activo.
  // 20_semaforo.js escribe/reemplaza esta tabla en cada ejecución.
  // Permite a Carlos ver en AppSheet:
  //   - Columna "Promedio Acumulado": promedio de todos los períodos cursados
  //   - Columna "Período Actual": promedio de actividades con nota publicada este período
  //   - Detalle por asignatura: Nota, Nivel, SemaforoColor, ActConNota, ActSinNota
  //
  // DECISIONES DE DISEÑO CONFIRMADAS (D1/D2/D3):
  //   D1 — Historial: nota final numérica de GradeHistory (MANUAL)
  //   D2 — Classroom: solo assignedGrade publicada. Sin nota → PENDIENTE (no promedia)
  //   D3 — Vista separada: Promedio_Acumulado y Nota (período actual) en columnas distintas
  //
  // POLÍTICA DE CALIFICACIÓN (DEC-2026-015):
  //   Escala 1.0–5.0. Umbral semáforo: GREEN ≥ 4.1 | YELLOW ≥ 3.0 | RED < 3.0
  //   GREY = sin datos suficientes (todo PENDIENTE o materia SIN_SYLLABUS)
  //
  // IDEMPOTENCIA: StudentID + SubjectCode + MomentCode + WindowCohortCode.
  // El semáforo borra y reescribe las filas del período activo en cada ejecución.
  "GradeAudit": [
    "GradeAuditID",       // TEXT — PK — "gau_<uuid>"
    "StudentID",          // ref Students (ADMIN)
    "FullName",           // TEXT — desnormalizado (FirstName + LastName)
    "ProgramCode",        // ref _CFG_PROGRAMS (CORE)
    "EntryCohortCode",    // ref _CFG_COHORTS — cohorte de ENTRADA — INMUTABLE
    "SubjectCode",        // ref _CFG_SUBJECTS (CORE)
    "SubjectName",        // TEXT — desnormalizado
    "MomentCode",         // ref _CFG_MOMENTS — momento activo en la ventana
    "WindowCohortCode",   // ref _CFG_COHORTS — ventana del aula (≠ EntryCohortCode posible)
    "Nota",               // NUMBER — promedio período actual (1.0–5.0) | NULL si sin datos
    "Nivel",              // INSUFICIENTE | ACEPTABLE | BUENO | EXCELENTE | PENDIENTE | SIN_SYLLABUS
    "SemaforoColor",      // GREEN | YELLOW | RED | GREY
    "Fuente",             // MANUAL (de GradeHistory) | CLASSROOM (de Classroom API)
    "ActConNota",         // NUMBER — actividades con assignedGrade publicada este período
    "ActSinNota",         // NUMBER — actividades sin nota publicada (pendientes docente)
    "PromedioAcumulado",  // NUMBER — promedio de TODOS los períodos cursados (hist + actual)
    "NivelAcumulado",     // INSUFICIENTE | ACEPTABLE | BUENO | EXCELENTE | PENDIENTE
    "GeneratedAt"         // DATETIME — timestamp de la última ejecución del semáforo
  ]
};


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 4: CONSTANTES OPERATIVAS COMPARTIDAS
// ═════════════════════════════════════════════════════════════════
// Usadas por 14_crearAulas, 05_estructurarAulas, 06_importarDocentes,
// 17_importarEstudiantes, 18_semaforo y 99_orquestador.
// Estables durante toda la Fase 1 — no se leen de Sheets en cada ejecución.
// Espejean los catálogos _CFG_MOMENTS y _CFG_PROGRAMS en Sheets.
// Si el modelo cambia aquí → actualizar también los Sheets + modelVersion.

/**
 * Orden cronológico de momentos dentro de su modalidad.
 * Espeja _CFG_MOMENTS.MomentOrder.
 * Usado para ordenar, comparar y validar MomentCode en los scripts.
 *
 * Mapeo equivalencia DIR ↔ ART:
 *   C1M1 ↔ A1B1+A1B2  |  C1M2 ↔ A1B3+A1B4
 *   C2M1 ↔ A2B1+A2B2  |  C2M2 ↔ A2B3+A2B4
 *   C3   ↔ A2B4 (PRL/TFG)
 */
const MOMENT_ORDER = {
  // DIR — Directo (6 momentos bimestrales)
  C1M1: 1, C1M2: 2, C2M1: 3, C2M2: 4, C3M1: 5, C3M2: 6,
  // ART — Articulado (8 bloques bimestrales)
  A1B1: 1, A1B2: 2, A1B3: 3, A1B4: 4,
  A2B1: 5, A2B2: 6, A2B3: 7, A2B4: 8
};

/**
 * Momentos válidos por modalidad en orden cronológico.
 * Espeja _CFG_MOMENTS WHERE ModalityType = 'DIR' | 'ART', ORDER BY MomentOrder.
 */
const MOMENTOS_DIR = ["C1M1", "C1M2", "C2M1", "C2M2", "C3M1", "C3M2"];
const MOMENTOS_ART = ["A1B1", "A1B2", "A1B3", "A1B4", "A2B1", "A2B2", "A2B3", "A2B4"];

/**
 * Programas técnicos activos.
 *   PROGRAMAS_ESPECIFICOS: excluye TRV (transversal — una sola aula compartida).
 *   TODOS_LOS_PROGRAMAS:   incluye TRV.
 * Espeja _CFG_PROGRAMS WHERE IsActive = true.
 */
const PROGRAMAS_ESPECIFICOS = ["CTB", "ADM", "TLC", "SIS", "MKT", "SST"];
const TODOS_LOS_PROGRAMAS   = ["CTB", "ADM", "TLC", "SIS", "MKT", "SST", "TRV"];


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 5: COLUMN_TYPES — tipos de columna por tabla
// ═════════════════════════════════════════════════════════════════
//
// PROPÓSITO:
//   Fuente de verdad del tipo de dato de cada columna para la Sheets Tables API.
//   Consumido por _buildAddTableRequest_() y aplicarDropdownsCatalogo()
//   en 02_SIDEP_HELPERS.gs.
//
// QUÉ SE DECLARA AQUÍ:
//   Solo las columnas que necesitan tipo explícito.
//   Los siguientes tipos son auto-detectados por convención de nombre
//   en _resolverTipoColumna_() y NO necesitan declararse:
//     Is*    → CHECKBOX (ej: IsActive, IsTransversal, IsFinalPeriod)
//     *Date  → DATE     (ej: StartDate, EndDate, GraduationDate)
//     *At    → DATE     (ej: CreatedAt, UpdatedAt, DeployedAt)
//
// TIPOS DISPONIBLES:
//   DROPDOWN_INLINE → lista fija corta hardcodeada.
//                     Aplicable durante setup (valores conocidos en tiempo de diseño).
//                     Ej: DIR|ART, CC|TI|CE, SUCCESS|ERROR|PARTIAL
//   DROPDOWN_CAT    → valores vienen de tabla _CFG_* poblada post-bootstrap.
//                     Requiere llamar aplicarDropdownsCatalogo() después de
//                     poblarConfiguraciones(). Ej: ref _CFG_PROGRAMS, _CFG_MOMENTS.
//                     statusType (opcional): filtra _CFG_STATUSES por StatusType.
//
// QUÉ NO SE DECLARA:
//   - Tablas _CFG_* de catálogo (sus columnas Code son la fuente, no refs externas)
//   - Columnas TEXT (default — no hace falta declarar el tipo por defecto)
//   - Columnas numéricas (NUMBER no confirmado como string válido en la API)

const COLUMN_TYPES = {

  // ── CORE ──────────────────────────────────────────────────────────────────

  // _CFG_SEMAFORO: sin DROPDOWN_CAT — solo Is* (auto CHECKBOX) y NUMBER (auto TEXT).
  // ConfigKey y ConfigLabel son TEXT libres — el semáforo los lee por nombre exacto.
  "_CFG_SEMAFORO": {},

  "_CFG_COHORTS": {
    "ModalityCode":  { type: "DROPDOWN_INLINE", values: ["DIR", "ART"] }
  },

  "_CFG_MOMENTS": {
    "ModalityType":  { type: "DROPDOWN_INLINE", values: ["DIR", "ART"] }
  },

  "_CFG_STATUSES": {
    // StatusType es una lista fija definida en el modelo — no es ref a catálogo
    "StatusType": { type: "DROPDOWN_INLINE", values: [
      "DEPLOYMENT", "RISK", "ENROLLMENT", "DEBT", "CONTRACT",
      "PRIORITY", "TASK", "INTERVENTION", "TEACHER_STATUS",
      "CONTACT_TYPE", "RECOGNITION_TYPE", "STRUCTURE",
      "APERTURA", "INVITATION"
    ]}
  },

  "_CFG_SUBJECTS": {
    "ProgramCode":    { type: "DROPDOWN_CAT",    source: "_CFG_PROGRAMS" },
    "CicloDir":       { type: "DROPDOWN_INLINE", values: ["C1", "C2", "C3"] },
    "CicloArt":       { type: "DROPDOWN_INLINE", values: ["A1", "A2"] },
    "DirStartMoment": { type: "DROPDOWN_CAT",    source: "_CFG_MOMENTS" },
    "DirEndMoment":   { type: "DROPDOWN_CAT",    source: "_CFG_MOMENTS" },
    "ArtStartBlock":  { type: "DROPDOWN_CAT",    source: "_CFG_MOMENTS" },
    "ArtEndBlock":    { type: "DROPDOWN_CAT",    source: "_CFG_MOMENTS" },
    // HasSyllabus no sigue convención Is* → no se auto-detecta como CHECKBOX.
    // Se declara como DROPDOWN_INLINE para dar experiencia de selección en el Sheet.
    // El semáforo lee "TRUE"/"FALSE" como string al consultar esta columna.
    "HasSyllabus":    { type: "DROPDOWN_INLINE", values: ["TRUE", "FALSE"] }
  },

  "_SYS_VERSION": {
    "Environment": { type: "DROPDOWN_INLINE", values: ["PRODUCTION", "STAGING", "TEST"] }
  },

  "_CFG_INSTITUTION": {
    "Timezone": { type: "DROPDOWN_INLINE", values: ["America/Bogota"] }
  },

  "MasterDeployments": {
    "ProgramCode":      { type: "DROPDOWN_CAT", source: "_CFG_PROGRAMS" },
    "ModalityCode":     { type: "DROPDOWN_CAT", source: "_CFG_MODALITIES" },
    "CohortCode":       { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "MomentCode":       { type: "DROPDOWN_CAT", source: "_CFG_MOMENTS" },
    "SubjectCode":      { type: "DROPDOWN_CAT", source: "_CFG_SUBJECTS" },
    "ScriptStatusCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "DEPLOYMENT" },
    "CampusCode":       { type: "DROPDOWN_CAT", source: "_CFG_CAMPUSES" }
  },

  "DeploymentTopics": {
    "SubjectCode":         { type: "DROPDOWN_CAT", source: "_CFG_SUBJECTS" },
    "StructureStatusCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "STRUCTURE" }
  },

  "APERTURA_PLAN": {
    "CohortCode":     { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "MomentCode":     { type: "DROPDOWN_CAT", source: "_CFG_MOMENTS" },
    "SubjectCode":    { type: "DROPDOWN_CAT", source: "_CFG_SUBJECTS" },
    "ProgramCode":    { type: "DROPDOWN_CAT", source: "_CFG_PROGRAMS" },
    "AperturaStatus": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "APERTURA" }
  },

  "_CFG_COHORT_CALENDAR": {
    "CohortCode": { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "MomentCode": { type: "DROPDOWN_CAT", source: "_CFG_MOMENTS" }
  },

  "_CFG_RECESSES": {
    // AppliesTo es texto libre (ALL o cualquier CohortCode dinámico) — TEXT
  },

  "Teachers": {
    "DocumentType":      { type: "DROPDOWN_INLINE", values: ["CC", "CE", "PAS"] },
    "CampusCode":        { type: "DROPDOWN_CAT", source: "_CFG_CAMPUSES" },
    "TeacherStatusCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "TEACHER_STATUS" }
  },

  // ── ADMIN ─────────────────────────────────────────────────────────────────

  "Students": {
    "DocumentType":      { type: "DROPDOWN_INLINE", values: ["CC", "TI", "CE"] },
    "StudentType":       { type: "DROPDOWN_INLINE", values: ["DIRECTO", "ARTICULADO"] },
    "CohortCode":        { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "ProgramCode":       { type: "DROPDOWN_CAT", source: "_CFG_PROGRAMS" },
    "CampusCode":        { type: "DROPDOWN_CAT", source: "_CFG_CAMPUSES" },
    "StudentStatusCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "ENROLLMENT" },
    "CompletionStatus":  { type: "DROPDOWN_INLINE",
                           values: ["IN_PROGRESS", "GRADUATED", "DROPPED", "EXTENDED", "TRANSFERRED"] }
  },

  "Enrollments": {
    "EntryCohortCode":      { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "WindowCohortCode":     { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "MomentCode":           { type: "DROPDOWN_CAT", source: "_CFG_MOMENTS" },
    "EnrollmentStatusCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "ENROLLMENT" }
  },

  "AcademicDebts": {
    "SubjectCode":    { type: "DROPDOWN_CAT", source: "_CFG_SUBJECTS" },
    "OriginalMoment": { type: "DROPDOWN_CAT", source: "_CFG_MOMENTS" },
    "DebtStatusCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "DEBT" }
  },

  "RiskFlags": {
    "SubjectCode":     { type: "DROPDOWN_CAT", source: "_CFG_SUBJECTS" },
    "EntryCohortCode": { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "RiskStatusCode":  { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "RISK" },
    "RiskCategory":    { type: "DROPDOWN_INLINE", values: ["ACADEMIC", "ADMIN", "ATTENDANCE"] }
  },

  "Interventions": {
    "InterventionTypeCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "INTERVENTION" }
  },

  "TeacherAssignments": {
    "CampusCode":       { type: "DROPDOWN_CAT",    source: "_CFG_STATUSES", statusType: "CONTRACT" },
    "ContractTypeCode": { type: "DROPDOWN_CAT",    source: "_CFG_STATUSES", statusType: "CONTRACT" },
    "InvitationStatus": { type: "DROPDOWN_CAT",    source: "_CFG_STATUSES", statusType: "INVITATION" },
    "DayOfWeek":        { type: "DROPDOWN_INLINE", values: ["LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES", "SABADO"] }
  },

  "StudentContacts": {
    "ContactTypeCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "CONTACT_TYPE" }
  },

  "ProgramTransfers": {
    "FromProgramCode": { type: "DROPDOWN_CAT", source: "_CFG_PROGRAMS" },
    "ToProgramCode":   { type: "DROPDOWN_CAT", source: "_CFG_PROGRAMS" },
    "FromCohortCode":  { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "ToCohortCode":    { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "TransferMoment":  { type: "DROPDOWN_CAT", source: "_CFG_MOMENTS" }
  },

  "ModalityTransitions": {
    "FromModalityCode": { type: "DROPDOWN_CAT", source: "_CFG_MODALITIES" },
    "ToModalityCode":   { type: "DROPDOWN_CAT", source: "_CFG_MODALITIES" },
    "ArtCohortCode":    { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "DirCohortCode":    { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "DirEntryMoment":   { type: "DROPDOWN_CAT", source: "_CFG_MOMENTS" }
  },

  "CreditRecognitions": {
    "SubjectCode":      { type: "DROPDOWN_CAT", source: "_CFG_SUBJECTS" },
    "OriginalModality": { type: "DROPDOWN_INLINE", values: ["ART", "DIR", "EXTERNAL"] },
    "RecognitionType":  { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "RECOGNITION_TYPE" }
  },

  "AdminTasks": {
    "PriorityCode":   { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "PRIORITY" },
    "TaskStatusCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "TASK" }
  },

  "AutomationLogs": {
    "System": { type: "DROPDOWN_INLINE", values: ["CLASSROOM", "SHEETS", "APPSHEET"] },
    "Result": { type: "DROPDOWN_INLINE", values: ["SUCCESS", "ERROR", "PARTIAL"] }
  },

  "_CFG_SYLLABUS": {
    "SubjectCode": { type: "DROPDOWN_CAT", source: "_CFG_SUBJECTS" },
    "Status":      { type: "DROPDOWN_INLINE", values: ["COMPLETO", "PENDIENTE"] }
  },

  "GradeHistory": {
    "SubjectCode":      { type: "DROPDOWN_CAT",    source: "_CFG_SUBJECTS" },
    "ProgramCode":      { type: "DROPDOWN_CAT",    source: "_CFG_PROGRAMS" },
    "EntryCohortCode":  { type: "DROPDOWN_CAT",    source: "_CFG_COHORTS" },
    "WindowCohortCode": { type: "DROPDOWN_CAT",    source: "_CFG_COHORTS" },
    "MomentCode":       { type: "DROPDOWN_CAT",    source: "_CFG_MOMENTS" },
    "Nivel":            { type: "DROPDOWN_INLINE", values: ["INSUFICIENTE", "ACEPTABLE", "BUENO", "EXCELENTE"] },
    "Estado":           { type: "DROPDOWN_INLINE", values: ["APROBADO", "REPROBADO"] },
    "Fuente":           { type: "DROPDOWN_INLINE", values: ["MANUAL", "CLASSROOM"] }
  },

  // ── BI ────────────────────────────────────────────────────────────────────

  "ViewActiveStudents": {
    "EntryCohortCode":      { type: "DROPDOWN_CAT", source: "_CFG_COHORTS" },
    "ProgramCode":          { type: "DROPDOWN_CAT", source: "_CFG_PROGRAMS" },
    "CampusCode":           { type: "DROPDOWN_CAT", source: "_CFG_CAMPUSES" },
    "EnrollmentStatusCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "ENROLLMENT" },
    "ActiveRiskStatusCode": { type: "DROPDOWN_CAT", source: "_CFG_STATUSES", statusType: "RISK" }
  },

  "ViewOperationalMetrics": {
    "CampusCode": { type: "DROPDOWN_CAT", source: "_CFG_CAMPUSES" }
  },

  "GradeAudit": {
    "SubjectCode":      { type: "DROPDOWN_CAT",    source: "_CFG_SUBJECTS" },
    "ProgramCode":      { type: "DROPDOWN_CAT",    source: "_CFG_PROGRAMS" },
    "EntryCohortCode":  { type: "DROPDOWN_CAT",    source: "_CFG_COHORTS" },
    "WindowCohortCode": { type: "DROPDOWN_CAT",    source: "_CFG_COHORTS" },
    "MomentCode":       { type: "DROPDOWN_CAT",    source: "_CFG_MOMENTS" },
    "Nivel":            { type: "DROPDOWN_INLINE", values: ["INSUFICIENTE", "ACEPTABLE", "BUENO", "EXCELENTE", "PENDIENTE", "SIN_SYLLABUS"] },
    "NivelAcumulado":   { type: "DROPDOWN_INLINE", values: ["INSUFICIENTE", "ACEPTABLE", "BUENO", "EXCELENTE", "PENDIENTE"] },
    "SemaforoColor":    { type: "DROPDOWN_INLINE", values: ["GREEN", "YELLOW", "RED", "GREY"] },
    "Fuente":           { type: "DROPDOWN_INLINE", values: ["MANUAL", "CLASSROOM"] }
  }
};
