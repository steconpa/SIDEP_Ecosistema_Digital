/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 00_SIDEP_CONFIG.gs
 * ============================================================
 *
 * PROPÓSITO:
 *   Fuente de verdad de constantes, definiciones de tablas y funciones
 *   helpers compartidas por TODOS los scripts del proyecto.
 *
 * REGLA DE ORO:
 *   Este archivo SOLO contiene:
 *     1. Constantes y configuración global (SIDEP_CONFIG)
 *     2. Definiciones de tablas (*_TABLES) — columnas, sin datos
 *     3. Constantes operativas compartidas (momentos, programas)
 *     4. Helpers de infraestructura reutilizables
 *   NUNCA contiene lógica de negocio ni datos de seed.
 *
 * SCOPE COMPARTIDO EN GAS:
 *   Todos los archivos del mismo proyecto Apps Script comparten scope global.
 *   Una función o constante definida aquí es visible en cualquier otro archivo
 *   sin necesidad de imports. Por esto, NO duplicar nombres entre archivos.
 *   El uso de `var` (en lugar de `const`) es obligatorio en GAS para evitar
 *   errores en versiones del motor V8 con modo strict parcial.
 *
 * ESTRUCTURA DEL PROYECTO (orden de ejecución en onboarding):
 *   00_SIDEP_CONFIG.gs           ← este archivo (compartido, no se ejecuta solo)
 *   00b_inicializarEcosistema.gs → crea estructura de carpetas en Google Drive
 *   01_setupSidepTables.gs       → crea los 3 Spreadsheets y todas las hojas
 *   02_poblarConfiguraciones.gs  → llena tablas _CFG_* con catálogos base
 *   02b_poblarAperturas.gs       → registra decisiones de Carlos en APERTURA_PLAN (v4.0.0)
 *   03_poblarSyllabus.gs         → llena _CFG_SYLLABUS con temarios (57 materias)
 *   04_crearAulas_v2.gs          → lee APERTURA_PLAN y crea aulas en Classroom (v4.0.0)
 *   05_estructurarAulas.gs       → crea Topics por semana en cada aula (Classroom API)
 *   06_importarDocentes.gs       → asigna docentes a deployments vía Classroom API
 *   07_importarEstudiantes.gs    → carga masiva de Students y Enrollments
 *   08_semaforo.gs               → trigger semanal — motor de riesgo académico
 *   99_orquestador.gs            → punto de entrada único para onboarding y diagnóstico
 *
 * MODELO CONVEYOR BELT:
 *   Cada cohorte (ventana) crea sus PROPIOS classrooms para los momentos que
 *   se dictan ese período. Las aulas NO se comparten entre ventanas.
 *   CohortCode en MasterDeployments = ventana que ABRIÓ el classroom (no la
 *   cohorte de entrada del estudiante).
 *
 *   Secuencia de momentos por cohorte (confirmada en Cronología_de_grupos.xlsx):
 *     EN26: C1M1→C1M2→C2M1→C2M2→C3M1→C3M2
 *     MR26: C1M2→C2M1→C2M2→C1M1→C3M1→C3M2  ← llena C1M1 en Sep-26 (nivelación)
 *     MY26: C2M1→C2M2→C1M1→C1M2→C3M1→C3M2  ← entra en C2M1
 *     AG26: C2M2→C1M1→C1M2→C2M1→C3M1→C3M2  ← entra en C2M2
 *     SP26: C1M1→C1M2→C2M1→C2M2→C3M1→C3M2  ← igual que EN26
 *   Todos completan los 6 momentos (C3 solo tras completar C1+C2).
 *
 *   Ejemplo de lectura de una nomenclatura:
 *     CTB-DIR-MR26-C1M2-SPC-001
 *       CTB  = programa Contabilidad
 *       DIR  = modalidad Directo
 *       MR26 = ventana que abrió el aula (Marzo 2026)
 *       C1M2 = momento académico
 *       SPC  = materia (Soportes y Comprobantes)
 *       001  = grupo
 *     En esta aula pueden estar matriculados tanto estudiantes EN26
 *     (que avanzan a C1M2) como nuevos MR26 (que inician ahí).
 *     El cohorte de ENTRADA del estudiante vive en:
 *       Students.CohortCode (inmutable) y Enrollments.EntryCohortCode.
 *     La ventana del aula donde está matriculado vive en:
 *       Enrollments.WindowCohortCode = CohortCode del deployment.
 *
 * MODELO FLEXIBLE DE APERTURAS (v4.0.0 — cambio arquitectural mayor):
 *   ANTES (v3.x): el sistema decidía qué aulas abrir filtrando
 *     _CFG_SUBJECTS.DirStartMoment === momentCode. Asumía estructura lineal fija.
 *     Problema: MY26 entra en C2M1 — el sistema no sabía distinguir qué materias
 *     de C2M1 eran para MY26 vs EN26. Tampoco representaba excepciones
 *     (estudiante rezagado, nivelación fuera de orden, docente no disponible).
 *   AHORA (v4.0): Carlos decide qué abre en cada cohorte/momento.
 *     Esa decisión se registra en APERTURA_PLAN (nueva tabla en CORE).
 *     04_crearAulas_v2.gs lee APERTURA_PLAN y crea exactamente esas aulas.
 *     DirStartMoment y demás campos siguen existiendo como referencia informativa
 *     de la malla oficial — no son filtros de control.
 *
 * VERSIONADO:
 *   modelVersion en SIDEP_CONFIG versiona el MODELO DE DATOS (esquema de tablas).
 *   Cada archivo .gs tiene su propio número de versión en su encabezado,
 *   que versiona la LÓGICA del script. Ambos números son independientes.
 *   Al cambiar el esquema de una tabla: actualizar modelVersion + tablas en Sheets.
 *
 * VERSIÓN DEL MODELO: 4.1.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-17
 *
 * CAMBIOS v4.1.0 vs v4.0.1:
 *   - MODIFICADA TeacherAssignments: +2 columnas al final (no rompe datos existentes):
 *       InvitationID     — ID retornado por Classroom.Invitations.create()
 *       InvitationStatus — ref _CFG_STATUSES (StatusType=INVITATION)
 *     IsActive cambia semántica: false hasta que el docente acepta la invitación.
 *   - NUEVO StatusType en _CFG_STATUSES: INVITATION (en 02_poblarConfiguraciones.gs)
 *       TEACHER_INVITED, TEACHER_ACCEPTED, TEACHER_DECLINED
 *     Razón: Google Workspace sin admin no puede usar Teachers.create() directo.
 *     06_importarDocentes.gs v8.0 usa Invitations.create() en su lugar.
 *   Acción requerida: setupSidepTables({force:true}) en TeacherAssignments
 *     para agregar las 2 columnas nuevas, luego poblarConfiguraciones({force:true}).
 *
 * CAMBIOS v4.0.1 vs v4.0.0 (correcciones de auditoría):
 *   - FIX: getSpreadsheetByName() usa getRootFolderSafe() en lugar de
 *     getRootFolder() @deprecated. Elimina O(n) scan de Drive en cada
 *     llamada — ahora usa el caché O(1) de ScriptProperties.
 *     Afectaba a todos los scripts que llaman getSpreadsheetByName().
 *
 * CAMBIOS v4.0.0 vs v3.6.1:
 *   MODELO DE DATOS:
 *   - NUEVA tabla CORE: APERTURA_PLAN — registra las decisiones de Carlos sobre
 *     qué asignaturas abrir por cohorte/momento. Reemplaza DirStartMoment como
 *     mecanismo de control de apertura en 04_crearAulas_v2. Ver documentación
 *     completa en la definición de la tabla abajo.
 *   - MODIFICADA _CFG_SUBJECTS: +2 columnas informativas entre ProgramCode y
 *     DirStartMoment: CicloDir (C1/C2/C3) y CicloArt (A1/A2). Total: 17→19 cols.
 *     DirStartMoment, DirEndMoment, ArtStartBlock, ArtEndBlock se CONSERVAN pero
 *     ahora son INFORMATIVOS (referencia malla oficial, no filtros de control).
 *   - MODIFICADA Enrollments: +1 columna AperturaID (ref APERTURA_PLAN) para
 *     trazabilidad completa. Vacío en Fase 1 — activar en Fase 2 sin migración.
 *   - NUEVO StatusType en _CFG_STATUSES: APERTURA — para estados de APERTURA_PLAN
 *     (PENDIENTE, CREADA, CANCELADA). Agregar en 02_poblarConfiguraciones.gs.
 *   SCRIPTS:
 *   - 04_crearAulas_v2.gs reemplaza 04_crearAulas.gs — lee APERTURA_PLAN.
 *   - 02b_poblarAperturas.gs (NUEVO) — gestiona el plan de aperturas por período.
 *   - leerSubjectsMap_() en 04_crearAulas_v2 detecta columnas por nombre de header
 *     en lugar de índices fijos → inmune a cambios futuros de schema.
 *   COMPATIBILIDAD:
 *   - 01_setupSidepTables.gs: sin cambios (itera CORE_TABLES automáticamente,
 *     crea APERTURA_PLAN y el nuevo header de _CFG_SUBJECTS).
 *   - 02_poblarConfiguraciones.gs: requiere PARCHE_poblarSubjects_v4.gs para
 *     escribir 19 columnas en _CFG_SUBJECTS (antes 17). El resto del archivo OK.
 *   - 03_poblarSyllabus.gs: sin cambios.
 *   - 05_estructurarAulas.gs: sin cambios (no lee _CFG_SUBJECTS directamente).
 *   - 06_importarDocentes.gs: sin cambios (no afectado por las tablas modificadas).
 *
 * CAMBIOS v3.6.1 vs v3.6.0:
 *   - var → const en todas las constantes globales. REVERTIDO en v4.0.0 a var
 *     por compatibilidad con motor GAS V8 en modo strict parcial.
 *   - NUEVO: getRootFolderSafe() — guarda y recupera rootFolderId desde
 *     ScriptProperties para evitar búsquedas lentas y ambigüedades con
 *     carpetas homónimas en Drive. getRootFolder() queda como wrapper
 *     de compatibilidad (@deprecated).
 *   - NUEVO: propKeys en SIDEP_CONFIG — centraliza los strings de
 *     ScriptProperties para evitar strings mágicos dispersos en el código.
 *   - FIX escribirDatos(): limpia filas antiguas antes de escribir para
 *     evitar datos basura cuando el nuevo dataset es menor al anterior.
 *   - NUEVO: aplicarFormatosAutomaticos_(ss, tables) — aplica formatos
 *     (checkboxes, fechas, números) a todas las hojas de un Spreadsheet.
 *     Resuelve bug crítico: la función era llamada en 03_poblarSyllabus.gs
 *     pero no estaba definida en ningún archivo del proyecto.
 *   - NUEVO: nowSIDEP() — timestamp estandarizado en America/Bogota.
 *     Reemplaza new Date() directo, que puede retornar UTC en servidores GAS.
 *   - NUEVO: uuid(prefix) — IDs prefijados legibles (ej: "dep_a1b2c3d4e5f6").
 *
 * CAMBIOS v3.6.0 vs v3.5.0:
 *   - MODELO CONVEYOR BELT activado — verificado contra Cronología_de_grupos.xlsx.
 *   - Eliminada COHORT_VENTANA_DIR_2026 (artefacto del modelo "Opción C" descartado).
 *     Los scripts requieren cohortCode explícito en cada llamada.
 *   - MasterDeployments.CohortCode redefinido como ventana que ABRIÓ el classroom
 *     (antes era la cohorte de entrada del estudiante — ahora eso vive en Enrollments).
 *
 * CAMBIOS v3.5.0 vs v3.4.1:
 *   - Nueva tabla CORE: DeploymentTopics — estructura pedagógica por aula.
 *     Campos de Fase 2 (CourseWorkCount, MaterialCount, AssignmentIDs) ya existen
 *     en el schema — activar Fase 2 NO requiere migración de tabla.
 *   - Nuevo StatusType STRUCTURE: TOPICS_CREATED | FULL | ERROR | PENDING.
 *   - Nuevo script 05_estructurarAulas.gs. Renumeración: 05_importar→06_.
 *   - Nueva Sección 5: MOMENT_ORDER, MOMENTOS_DIR/ART, PROGRAMAS_ESPECIFICOS.
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
// SECCIÓN 1: CONFIGURACIÓN GLOBAL
// ─────────────────────────────────────────────────────────────

/**
 * SIDEP_CONFIG — Parámetros globales del ecosistema.
 * Modificar aquí afecta a TODOS los scripts del proyecto.
 */
var SIDEP_CONFIG = {
  // Estructura de carpetas en Google Drive
  rootFolderName: "00_SIDEP_ECOSISTEMA_DIGITAL",
  dbFolderName:   "01_BASES_DE_DATOS_MAESTRAS",

  // Nombres de los Spreadsheets (no cambiar en producción sin migración de datos)
  files: {
    core:  "SIDEP_01_CORE_ACADEMICO",
    admin: "SIDEP_02_GESTION_ADMIN",
    bi:    "SIDEP_03_BI_DASHBOARD"
  },

  // Estilo de encabezados — aplica a todas las tablas via configurarTablas_()
  headerStyle: {
    background: "#1a3c5e",
    fontColor:  "#ffffff",
    fontWeight: "bold"
  },

  // Timezone oficial del sistema — America/Bogota (UTC-5)
  // CRÍTICO: todas las fechas del Semáforo deben usar este timezone.
  // Usar nowSIDEP() en lugar de new Date() en todos los scripts.
  timezone: "America/Bogota",

  // Campus por defecto (Fase 1 — sede única Bogotá)
  defaultCampus: "BOGOTA",

  // Versión actual del modelo de datos.
  // Incrementar cuando cambie el schema de cualquier tabla.
  // Independiente de las versiones de cada script individual.
  modelVersion: "4.1.0",

  // Claves centralizadas de ScriptProperties — evita strings mágicos dispersos.
  // Todos los scripts deben leer/escribir ScriptProperties usando estas claves.
  propKeys: {
    rootFolderId: "sidep_rootFolderId"   // ID de la carpeta raíz en cache O(1)
  }
};


// ─────────────────────────────────────────────────────────────
// SECCIÓN 2: DEFINICIÓN DE TABLAS — CORE (SIDEP_01_CORE_ACADEMICO)
// ─────────────────────────────────────────────────────────────
// Solo columnas — SIN datos. Los datos van en 02_poblarConfiguraciones.gs
// y 02b_poblarAperturas.gs.

var CORE_TABLES = {

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
  //   APERTURA       → NUEVO v4.0.0 — estado de APERTURA_PLAN: PENDIENTE|CREADA|CANCELADA
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

  // Catálogo de materias — fuente de verdad para nomenclatura y datos de cada asignatura.
  //
  // CAMBIO v4.0.0 — DOS COLUMNAS NUEVAS + CAMBIO SEMÁNTICO EN CUATRO EXISTENTES:
  //
  //   COLUMNAS NUEVAS (entre ProgramCode y DirStartMoment):
  //     CicloDir — C1 | C2 | C3 — ciclo al que pertenece la materia en DIR.
  //     CicloArt — A1 | A2      — ciclo al que pertenece la materia en ART.
  //     Son INFORMATIVAS — indican dónde está la materia en la malla oficial.
  //     Total columnas: 17 (v3.6.1) → 19 (v4.0.0).
  //
  //   CAMBIO SEMÁNTICO (no de schema) en DirStartMoment, DirEndMoment,
  //   ArtStartBlock, ArtEndBlock: se CONSERVAN pero ahora son INFORMATIVOS.
  //     En v3.x: 04_crearAulas.gs los usaba como filtros para decidir qué crear.
  //     En v4.0: ese rol lo cumple APERTURA_PLAN. Estos campos sirven para:
  //       - Orientación de Carlos al planificar aperturas cada período
  //       - Reportes de desviación vs malla oficial (Fase 2)
  //       - Validaciones de prerrequisitos (Fase 2)
  //     04_crearAulas_v2.gs NO los consulta para ninguna decisión de apertura.
  //
  //   IMPACTO EN SCRIPTS:
  //     02_poblarConfiguraciones.gs → poblarSubjects_() debe usar
  //       PARCHE_poblarSubjects_v4.gs (escribe 19 cols, no 17).
  //     04_crearAulas_v2.gs → leerSubjectsMap_() usa headers dinámicos,
  //       no índices fijos → inmune al cambio y a futuros cambios de schema.
  "_CFG_SUBJECTS": [
    "SubjectID",
    "SubjectCode",       // FUC, APU, NLV... — clave de nomenclatura de aulas
    "SubjectName",
    "ProgramCode",       // ref _CFG_PROGRAMS — TRV si es transversal a todos
    "CicloDir",          // NUEVO v4.0 — C1 | C2 | C3 — ciclo sugerido DIR (informativo)
    "CicloArt",          // NUEVO v4.0 — A1 | A2 — ciclo sugerido ART (informativo)
    "DirStartMoment",    // INFORMATIVO v4.0 — ref _CFG_MOMENTS (DIR) — referencia malla oficial
    "DirEndMoment",      // INFORMATIVO v4.0 — = DirStartMoment si la materia dura un solo momento
    "ArtStartBlock",     // INFORMATIVO v4.0 — ref _CFG_MOMENTS (ART)
    "ArtEndBlock",       // INFORMATIVO v4.0 — = ArtStartBlock si dura un solo bloque
    "Credits",
    "Hours",
    "IsTransversal",     // BOOLEAN — true = UNA sola aula compartida por todos los programas
    "IsActive",
    "Notes",
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Tabla de versiones — registro inmutable de cada deploy.
  // Cada ejecución de setupSidepTables() AGREGA una fila, nunca sobrescribe.
  // Permite auditar: quién ejecutó, cuándo, cuántas tablas, entorno, duración.
  // ScriptHash = timestamp ms de inicio — correlaciona con logs de GAS.
  "_SYS_VERSION": [
    "VersionID",       // TEXT — PK (ver_<timestamp_ms>)
    "VersionNumber",   // TEXT — 4.0.0
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
  // MODELO CONVEYOR BELT (v3.6.0, sin cambios de schema en v4.0.0):
  //   CohortCode = VENTANA QUE ABRIÓ EL CLASSROOM (no cohorte de entrada del estudiante).
  //   Cada ventana crea sus propios classrooms para los momentos que se dictan ese mes.
  //   Ejemplo: CTB-DIR-MR26-C1M2-SPC-001 → CohortCode=MR26
  //            Entran: estudiantes EN26 que avanzan a C1M2 + nuevos MR26 que inician ahí.
  //   El cohorte de ENTRADA del estudiante vive en:
  //     Students.CohortCode (inmutable) y Enrollments.EntryCohortCode (inmutable).
  //   La ventana del aula donde está matriculado vive en:
  //     Enrollments.WindowCohortCode = CohortCode del deployment.
  //
  // RELACIÓN CON APERTURA_PLAN (v4.0.0):
  //   Cada fila de MasterDeployments tiene origen en una fila de APERTURA_PLAN.
  //   Cuando 04_crearAulas_v2.gs procesa una apertura:
  //     1. Genera una fila PENDING aquí con el DeploymentID
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
    "GeneratedNomenclature",  // CTB-DIR-MR26-C1M2-SPC-001 — clave de idempotencia del sistema
    "GeneratedClassroomName", // [CTB] Soportes Contables | C1M2 · MR26
    "ClassroomID",            // ID de Google Classroom — vacío hasta crearAulas()
    "ClassroomURL",           // URL del aula — vacío hasta crearAulas()
    "ScriptStatusCode",       // ref _CFG_STATUSES (StatusType=DEPLOYMENT): PENDING|CREATED|ERROR|ARCHIVED
    "CampusCode",             // ref _CFG_CAMPUSES
    "CreatedAt",
    "CreatedBy",
    "Notes"
  ],

  // Estructura pedagógica de cada aula — una fila por semana × deployment.
  //
  // Fase 1: Topics vacíos — el docente llena el contenido manualmente en Classroom.
  //         StructureStatusCode final esperado: TOPICS_CREATED.
  // Fase 2: CourseWorkCount / MaterialCount / AssignmentIDs se populan cuando
  //         se automatice la carga de actividades y recursos.
  //         El schema NO cambia al activar Fase 2 — los campos ya existen.
  //
  // StructureStatusCode ref _CFG_STATUSES (StatusType=STRUCTURE):
  //   TOPICS_CREATED   → Topics creados con nombre, docente llena contenido (Fase 1)
  //   FULL             → Topics + CourseWork + Materials completos (Fase 2)
  //   STRUCTURE_ERROR  → Fallo al crear en Classroom API — ver AssignmentIDs
  //   STRUCTURE_PENDING → Aún no procesado por estructurarAulas()
  //
  // NOTA AssignmentIDs (uso dual):
  //   Fase 2: lista de IDs de actividades separados por pipe.
  //   Fase 1 ERROR: almacena el mensaje de error (único campo libre disponible).
  "DeploymentTopics": [
    "TopicRowID",            // TEXT — PK — "top_<uuid>"
    "DeploymentID",          // ref MasterDeployments
    "ClassroomCourseID",     // ClassroomID del aula — redundante pero optimiza API calls
    "ClassroomTopicID",      // ID devuelto por Classroom.Courses.Topics.create()
    "SubjectCode",           // ref _CFG_SUBJECTS — redundante, optimiza queries BI
    "WeekNumber",            // NUMBER — 1, 2, 3...
    "TopicName",             // "Semana 1 · Introducción a la Contabilidad"
    "StructureStatusCode",   // ref _CFG_STATUSES (StatusType=STRUCTURE)
    // ── Campos Fase 2 (vacíos en Fase 1 — schema estable, NO eliminar) ──────────
    "CourseWorkCount",       // NUMBER — tareas creadas en este topic (0 en Fase 1)
    "MaterialCount",         // NUMBER — materiales creados en este topic (0 en Fase 1)
    "AssignmentIDs",         // TEXT — IDs pipe-separated (Fase 2) | mensaje error (si STRUCTURE_ERROR)
    // ── Trazabilidad ─────────────────────────────────────────────────────────────
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // ══════════════════════════════════════════════════════════════════════════════
  // NUEVA TABLA v4.0.0 — APERTURA_PLAN
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // PROPÓSITO:
  //   Registrar explícitamente las decisiones de Carlos sobre qué asignaturas
  //   abrir en cada cohorte y momento. Es la fuente de verdad que 04_crearAulas_v2
  //   consulta para saber qué aulas crear.
  //   Reemplaza DirStartMoment como mecanismo de control de apertura (v3.x).
  //
  // QUIÉN LA LLENA:
  //   Stevens, vía 02b_poblarAperturas.gs, basado en instrucciones de Carlos
  //   al inicio de cada período académico (WhatsApp, reunión de planeación).
  //
  // FLUJO DE ESTADOS (AperturaStatus — ref _CFG_STATUSES StatusType=APERTURA):
  //   PENDIENTE  → Carlos aprobó abrir esta asignatura, 04_crearAulas_v2 aún no la procesa
  //   CREADA     → 04_crearAulas_v2 generó la fila en MasterDeployments y creó el aula
  //   CANCELADA  → Carlos decidió no abrir (docente no disponible, grupo muy pequeño, etc.)
  //
  //   Solo las filas PENDIENTE son procesadas por 04_crearAulas_v2.
  //   Al crear el aula, el script actualiza a CREADA y escribe el DeploymentID generado.
  //   Las CANCELADAS nunca se procesan — quedan como registro de auditoría permanente.
  //
  // CASOS DE USO QUE RESUELVE:
  //   1. Apertura normal: MR26 abre SPC en C1M2 según malla oficial.
  //   2. Cohorte con entrada no estándar: MY26 entra en C2M1 (no C1M1).
  //      → APERTURA_PLAN registra exactamente lo que Carlos confirma.
  //   3. Nivelación: MR26 cursa C1M1 en Sep-26 (después de completar C1M2 y C2).
  //      → Una apertura normal; el sistema no restringe ni valida el orden.
  //   4. Excepción individual: estudiante rezagado necesita una asignatura fuera
  //      del ritmo del cohorte. → Se agrega una entrada con grupo 002 o con
  //      notas explicativas. El sistema la crea sin restricciones.
  //   5. Cancelación por docente: Carlos confirma que no habrá docente para TLC/FOT
  //      esta ventana. → AperturaStatus = CANCELADA, queda documentado.
  //
  // IDEMPOTENCIA EN poblarAperturas():
  //   Clave = CohortCode + MomentCode + SubjectCode + ProgramCode.
  //   Re-ejecutar en modo SAFE no duplica registros.
  //   Re-ejecutar con force=true limpia y reescribe solo el cohorte indicado.
  //
  // MATERIAS TRANSVERSALES (IsTransversal = true en _CFG_SUBJECTS):
  //   UNA sola fila en APERTURA_PLAN → UNA sola aula en MasterDeployments.
  //   ProgramCode = 'TRV'. Todos los estudiantes del momento comparten esa aula.
  //   04_crearAulas_v2 detecta IsTransversal con header dinámico y previene
  //   crear aulas duplicadas aunque el código aparezca en múltiples programas.
  "APERTURA_PLAN": [
    "AperturaID",       // TEXT — PK — "apr_<uuid>"
    "CohortCode",       // ref _CFG_COHORTS — ventana que ABRE el aula
    "MomentCode",       // ref _CFG_MOMENTS — momento académico de apertura
    "SubjectCode",      // ref _CFG_SUBJECTS — asignatura a abrir
    "ProgramCode",      // ref _CFG_PROGRAMS — TRV si es transversal
    "IsTransversal",    // BOOLEAN — true = una sola aula compartida por todos los programas
    "AperturaStatus",   // PENDIENTE | CREADA | CANCELADA (ref _CFG_STATUSES StatusType=APERTURA)
    "DeploymentID",     // ref MasterDeployments — se llena cuando AperturaStatus=CREADA
    "PlannedBy",        // TEXT — email de quien registró la apertura (Stevens)
    "PlannedAt",        // DATETIME — cuándo se registró en el sistema
    "Notes",            // TEXT — razón de excepción si no sigue la malla oficial
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Tabla puente Cohorte × Momento → fechas reales del calendario académico.
  // FUENTE DE VERDAD del calendario — usada por el Semáforo (08_semaforo.gs).
  //
  // El Semáforo consulta: StartDate <= HOY <= EndDate AND IsActive = true
  //   para derivar el período activo de cada estudiante.
  //
  // IMPORTANTE — cohorte de entrada vs ventana del aula:
  //   CohortCode aquí = cohorte de ENTRADA del estudiante (EN26, MR26...).
  //   CohortCode en MasterDeployments = ventana que ABRIÓ el classroom.
  //   Son distintos: un estudiante EN26 puede estar cursando en un aula MR26.
  //   El Semáforo usa esta tabla (entrada) para saber en qué momento está HOY,
  //   luego busca el deployment correcto en MasterDeployments.
  //
  // COHORTES QUE COMPARTEN FECHAS:
  //   MY26, AG26 y SP26 coinciden en algunas fechas con cohortes anteriores.
  //   Correcto: comparten CALENDARIO pero cada uno tiene sus propias aulas.
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
  // Comportamiento del Semáforo durante receso activo (IsActive=true):
  //   → NO recalcula estados de riesgo
  //   → NO marca rojo por inactividad en el aula
  //   → Mantiene el último estado calculado antes del receso
  // AppliesTo = ALL aplica a todos los cohortes activos.
  // AppliesTo = CohortCode específico para recesos parciales (Fase 2).
  // IsActive=false en rec_2027_SS: fecha aproximada — activar solo tras
  //   confirmación oficial del MEN (Ministerio de Educación Nacional).
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

  // Entidad docente propia (FIX-36 v3.3.0).
  // Reemplaza strings sueltos TeacherName/TeacherEmail en TeacherAssignments.
  // Un cambio de email del docente se hace UNA sola vez aquí y se propaga.
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


// ─────────────────────────────────────────────────────────────
// SECCIÓN 3: DEFINICIÓN DE TABLAS — ADMIN (SIDEP_02_GESTION_ADMIN)
// ─────────────────────────────────────────────────────────────

var ADMIN_TABLES = {

  // Registro maestro de estudiantes.
  // CohortCode aquí = cohorte de ENTRADA (EN26, MR26...) — INMUTABLE.
  // CompletionStatus válidos por StudentStatusCode:
  //   ACTIVE    → IN_PROGRESS  (único válido — AppSheet valida con Valid_If)
  //   GRADUATED → GRADUATED
  //   DROPPED   → DROPPED | IN_PROGRESS
  //   WITHDRAWN → IN_PROGRESS | DROPPED
  //   COMPLETED → GRADUATED | EXTENDED
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
  // EntryCohortCode = cohorte de ENTRADA del estudiante (EN26) — INMUTABLE.
  // WindowCohortCode = ventana del AULA donde está matriculado.
  // Ejemplo: estudiante EN26 cursando C1M2 en ventana MR26:
  //   → EntryCohortCode = EN26, WindowCohortCode = MR26.
  // AttemptNumber: 1=primera vez, 2=primer reintento, 3=segundo reintento.
  //
  // CAMBIO v4.0.0: nueva columna AperturaID (ref APERTURA_PLAN).
  //   Permite trazar qué decisión de apertura de Carlos originó cada matrícula.
  //   En Fase 1 puede quedar vacío (no bloquea funcionalidad).
  //   07_importarEstudiantes.gs debe escribir AperturaID al matricular (Fase 2).
  "Enrollments": [
    "EnrollmentID",
    "StudentID",            // ref Students
    "DeploymentID",         // ref MasterDeployments
    "AperturaID",           // NUEVO v4.0 — ref APERTURA_PLAN (trazabilidad) — vacío en Fase 1
    "EntryCohortCode",      // ref _CFG_COHORTS — cohorte de ENTRADA — INMUTABLE
    "WindowCohortCode",     // ref _CFG_COHORTS — ventana del AULA (= CohortCode del deployment)
    "MomentCode",           // ref _CFG_MOMENTS
    "AttemptNumber",        // NUMBER — 1=primera vez, 2=reintento...
    "EnrollmentStatusCode", // ref _CFG_STATUSES (StatusType=ENROLLMENT)
                            //   ACTIVE | COMPLETED | FAILED | DROPPED | WITHDRAWN
    "CreatedAt",
    "CreatedBy",
    "UpdatedAt",
    "UpdatedBy"
  ],

  // Deuda académica por asignatura (FIX-30 v3.2.9).
  // Se crea automáticamente cuando EnrollmentStatusCode → FAILED.
  // Flujo: DEBT_PENDING → DEBT_IN_RETRY → DEBT_CLEARED.
  // DebtStatusCode ref _CFG_STATUSES (StatusType=DEBT):
  //   DEBT_PENDING:  reprobó, sin aula de reintento asignada aún
  //   DEBT_IN_RETRY: ya matriculado en aula de reintento
  //   DEBT_CLEARED:  aprobó el reintento — deuda saldada
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

  // Semáforo académico — una fila por riesgo activo (FIX-31 v3.2.9).
  // DeploymentID + SubjectCode permiten identificar exactamente dónde está el riesgo.
  // RiskStatusCode ref _CFG_STATUSES (StatusType=RISK) — GREEN | YELLOW | RED.
  // IsActive = FALSE cuando se resuelve (historial permanente — nunca se borra).
  "RiskFlags": [
    "RiskID",
    "StudentID",            // ref Students
    "DeploymentID",         // ref MasterDeployments — aula que generó el riesgo
    "SubjectCode",          // ref _CFG_SUBJECTS — redundante pero optimiza queries BI
    "EntryCohortCode",      // cohorte de entrada del estudiante (para filtros AppSheet)
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

  // Asignaciones de docentes a deployments (FIX-33 v3.2.9 + FIX-36 v3.3.0).
  // TeacherID reemplazó TeacherName + TeacherEmail (FIX-36).
  // DeploymentID reemplazó CohortCode (FIX-33).
  // ContractTypeCode ref _CFG_STATUSES (StatusType=CONTRACT).
  // Asignaciones de docentes a deployments (FIX-33 v3.2.9 + FIX-36 v3.3.0).
  // TeacherID reemplazó TeacherName + TeacherEmail (FIX-36).
  // DeploymentID reemplazó CohortCode (FIX-33).
  // ContractTypeCode ref _CFG_STATUSES (StatusType=CONTRACT).
  //
  // CAMBIO v4.1.0 — MODELO DE INVITACIONES (reemplaza Teachers.create):
  //   Google Workspace sin permisos de domain admin no puede agregar co-teachers
  //   directamente. Se usa Classroom.Invitations.create() en su lugar.
  //   El docente recibe un email y debe ACEPTAR la invitación.
  //   IsActive = false hasta que el docente acepta (no es una restricción del sistema,
  //   sino un reflejo honesto del estado real en Classroom).
  //   InvitationID: ID retornado por la API — permite verificar estado de la invitación
  //   vía Classroom.Invitations.get(id) en Fase 2.
  //   InvitationStatus ref _CFG_STATUSES (StatusType=INVITATION):
  //     TEACHER_INVITED   → invitación enviada, pendiente de aceptación
  //     TEACHER_ACCEPTED  → docente aceptó (actualizar manualmente en Fase 1,
  //                         automáticamente vía trigger en Fase 2)
  //     TEACHER_DECLINED  → docente rechazó (reenviar o cambiar docente)
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
    "InvitationID",         // NUEVO v4.1.0 — ID de Classroom.Invitations.create()
    "InvitationStatus"      // NUEVO v4.1.0 — ref _CFG_STATUSES (StatusType=INVITATION)
  ],

  // Contactos de estudiantes (FIX-37 v3.3.0).
  // OBLIGATORIO para articulados (FB26) — son menores de edad.
  // Regla: todo estudiante ART necesita al menos 1 contacto IsLegalGuardian=true
  //        antes de activar su primera Enrollment.
  // ContactTypeCode ref _CFG_STATUSES (StatusType=CONTACT_TYPE).
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

  // ── TABLAS STUB — Movilidad estudiantil (FIX-38 v3.3.0) ──────────────────────
  // Estado: estructura creada, SIN datos, SIN lógica activa en Fase 1.
  // Activar en Fase 2 sin migración de esquema — el schema ya es el definitivo.

  // Transferencia entre programas del mismo nivel (ADM→CTB, SIS→TLC, etc.).
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

  // Transición ART→DIR — DirEntryMoment = momento desde donde empieza como DIR.
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

  // Convalidaciones y homologaciones.
  // RecognitionType ref _CFG_STATUSES (StatusType=RECOGNITION_TYPE).
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

  // Temario semanal de cada materia (FIX v3.4.0).
  // Estructura creada en setup; datos poblados por 03_poblarSyllabus.gs.
  // Status: COMPLETO | PENDIENTE.
  // 05_estructurarAulas.gs lee esta tabla para generar TopicName en Classroom:
  //   "Semana {N} · {WeekTitle}"
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
  ]
};


// ─────────────────────────────────────────────────────────────
// SECCIÓN 4: DEFINICIÓN DE TABLAS — BI (SIDEP_03_BI_DASHBOARD)
// ─────────────────────────────────────────────────────────────

var BI_TABLES = {

  // Vista agregada de estudiantes activos — refrescada por el Semáforo semanal.
  // GeneratedAt permite detectar si la vista está desactualizada en AppSheet.
  "ViewActiveStudents": [
    "StudentID",
    "FullName",
    "EntryCohortCode",
    "ProgramCode",
    "CampusCode",
    "EnrollmentStatusCode",
    "ActiveRiskStatusCode",
    "OpenInterventions",    // NUMBER — intervenciones activas sin resolver
    "PendingDebts",         // NUMBER — asignaturas con deuda activa (AcademicDebts)
    "GeneratedAt"           // DATETIME — timestamp del último refresh del Semáforo
  ],

  // Métricas operacionales mensuales — alimenta el Dashboard Ejecutivo de Carlos
  // (AppSheet Dashboard Ejecutivo Móvil — Semana 5 del roadmap).
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
  ]
};


// ─────────────────────────────────────────────────────────────
// SECCIÓN 5: CONSTANTES OPERATIVAS COMPARTIDAS
// ─────────────────────────────────────────────────────────────
// Usadas por 04_crearAulas_v2, 05_estructurarAulas, 07_importarEstudiantes,
// 08_semaforo y 99_orquestador.
// Estables durante toda la Fase 1 — no se leen de Sheets en cada ejecución.
//
// Patrón de diseño:
//   Datos de negocio (matrículas, asistencia, riesgo) → Sheets (dinámico)
//   Datos de modelo (qué momentos y programas existen) → aquí (estático)
//
// Si el modelo cambia (nuevo programa, nuevo momento):
//   1. Actualizar aquí
//   2. Actualizar _CFG_MOMENTS / _CFG_PROGRAMS en Sheets
//   3. Incrementar modelVersion en SIDEP_CONFIG
//   4. Re-ejecutar setupSidepTables() + poblarConfiguraciones()
//
// NOTA v3.6.0: Eliminada COHORT_VENTANA_DIR_2026 (era artefacto del modelo
//   "Opción C", ya descartado). Los scripts deben recibir cohortCode explícito
//   en cada llamada. No existe ventana canónica fija en el conveyor belt.
// ─────────────────────────────────────────────────────────────

/**
 * Orden cronológico de momentos dentro de su modalidad.
 * Espeja _CFG_MOMENTS.MomentOrder.
 * Usado para ordenar, comparar y validar MomentCode en los scripts.
 * Mapeo equivalencia DIR ↔ ART:
 *   C1M1 ↔ A1B1+A1B2  |  C1M2 ↔ A1B3+A1B4
 *   C2M1 ↔ A2B1+A2B2  |  C2M2 ↔ A2B3+A2B4
 *   C3   ↔ A2B4 (PRL/TFG)
 */
var MOMENT_ORDER = {
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
var MOMENTOS_DIR = ["C1M1", "C1M2", "C2M1", "C2M2", "C3M1", "C3M2"];
var MOMENTOS_ART = ["A1B1", "A1B2", "A1B3", "A1B4", "A2B1", "A2B2", "A2B3", "A2B4"];

/**
 * Programas técnicos activos.
 *   PROGRAMAS_ESPECIFICOS: excluye TRV (transversal — una sola aula compartida).
 *   TODOS_LOS_PROGRAMAS:   incluye TRV.
 * Espeja _CFG_PROGRAMS WHERE IsActive = true.
 */
var PROGRAMAS_ESPECIFICOS = ["CTB", "ADM", "TLC", "SIS", "MKT", "SST"];
var TODOS_LOS_PROGRAMAS   = ["CTB", "ADM", "TLC", "SIS", "MKT", "SST", "TRV"];


// ─────────────────────────────────────────────────────────────
// SECCIÓN 6: HELPERS COMPARTIDOS DE INFRAESTRUCTURA
// ─────────────────────────────────────────────────────────────
// Disponibles en todos los archivos del proyecto sin imports.

/**
 * Localiza la carpeta raíz del proyecto en Google Drive.
 * Lanza error descriptivo si no existe.
 * @deprecated — usar getRootFolderSafe() que tiene caché O(1) via ScriptProperties.
 */
function getRootFolder() {
  var folders = DriveApp.getFoldersByName(SIDEP_CONFIG.rootFolderName);
  if (!folders.hasNext()) {
    throw new Error(
      "📁 Carpeta raíz '" + SIDEP_CONFIG.rootFolderName + "' no encontrada en Drive. " +
      "Ejecuta inicializarEcosistema() o setupSidepTables() primero."
    );
  }
  return folders.next();
}

/**
 * Localiza la carpeta raíz usando ScriptProperties como caché O(1).
 * Primera llamada: busca por nombre en Drive y guarda el ID en ScriptProperties.
 * Llamadas siguientes: recupera el ID del caché en lugar de escanear Drive.
 *
 * Ventajas vs getRootFolder():
 *   - Evita ambigüedad si existen carpetas homónimas en Drive.
 *   - ~10× más rápido en ejecuciones sucesivas (O(1) vs O(n) búsqueda).
 *   - El ID en caché sobrevive cambios de nombre de la carpeta.
 *
 * Lanza error descriptivo si la carpeta no existe ni en caché ni en Drive.
 */
function getRootFolderSafe() {
  var props  = PropertiesService.getScriptProperties();
  var cached = props.getProperty(SIDEP_CONFIG.propKeys.rootFolderId);

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
  var folders = DriveApp.getFoldersByName(SIDEP_CONFIG.rootFolderName);
  if (!folders.hasNext()) {
    throw new Error(
      "📁 Carpeta raíz '" + SIDEP_CONFIG.rootFolderName + "' no encontrada en Drive. " +
      "Ejecuta inicializarEcosistema() o setupSidepTables() primero."
    );
  }
  var folder = folders.next();

  // Guardar en caché para todas las llamadas siguientes
  props.setProperty(SIDEP_CONFIG.propKeys.rootFolderId, folder.getId());
  Logger.log("  ✔  rootFolderId cacheado en ScriptProperties: " + folder.getId());
  return folder;
}

/**
 * Localiza una subcarpeta dentro de un folder padre.
 * Lanza error descriptivo si no existe para guiar al desarrollador.
 */
function getSubFolder(parentFolder, subFolderName) {
  var sub = parentFolder.getFoldersByName(subFolderName);
  if (!sub.hasNext()) {
    throw new Error(
      "📁 Subcarpeta '" + subFolderName + "' no encontrada dentro de '" +
      parentFolder.getName() + "'."
    );
  }
  return sub.next();
}

/**
 * Obtiene o crea un Spreadsheet en la carpeta indicada.
 * Si ya existe: lo reutiliza (idempotente). Si no: lo crea y mueve a la carpeta.
 * Llamado por setupSidepTables() para los 3 Spreadsheets del ecosistema.
 */
function getOrCreateSpreadsheet(name, folder) {
  var files = folder.getFilesByName(name);
  if (files.hasNext()) {
    return SpreadsheetApp.open(files.next());
  }
  var ss   = SpreadsheetApp.create(name);
  var file = DriveApp.getFileById(ss.getId());
  file.moveTo(folder);
  Logger.log("  ➕ Spreadsheet creado: " + name);
  return ss;
}

/**
 * Obtiene un Spreadsheet existente por nombre (sin crear).
 * Usado por scripts que solo leen/escriben datos (poblarConfiguraciones, etc.)
 * Usa getRootFolderSafe() con caché O(1) via ScriptProperties.
 * @param {string} fileKey — clave de SIDEP_CONFIG.files (core | admin | bi)
 */
function getSpreadsheetByName(fileKey) {
  var fileName = SIDEP_CONFIG.files[fileKey];
  if (!fileName) {
    throw new Error("fileKey inválido: '" + fileKey + "'. Usar: core | admin | bi");
  }
  var root     = getRootFolderSafe();
  var dbFolder = getSubFolder(root, SIDEP_CONFIG.dbFolderName);
  var files    = dbFolder.getFilesByName(fileName);
  if (!files.hasNext()) {
    throw new Error(
      "📄 Archivo '" + fileName + "' no encontrado en Drive. " +
      "Ejecuta setupSidepTables() primero."
    );
  }
  return SpreadsheetApp.open(files.next());
}

/**
 * Timestamp estandarizado en America/Bogota (UTC-5).
 * SIEMPRE usar esta función en lugar de new Date() directo en todos los scripts.
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
 * Ejemplo: uuid("dep")  → "dep_a1b2c3d4e5f6"
 *          uuid("apr")  → "apr_9f8e7d6c5b4a"
 *          uuid("top")  → "top_3c2b1a0f9e8d"
 *          uuid()       → "a1b2c3d4e5f6"
 *
 * Ventaja vs Utilities.getUuid(): el prefijo hace los IDs identificables
 * visualmente en Sheets y en el Logger sin necesidad de conocer el contexto.
 *
 * @param  {string} [prefix] — prefijo legible (ej: "dep", "apr", "enr", "top", "dbt")
 * @returns {string}
 */
function uuid(prefix) {
  var id = Utilities.getUuid().replace(/-/g, "").substring(0, 12);
  return prefix ? prefix + "_" + id : id;
}

/**
 * Aplica formatos (checkboxes, fechas, números) a TODAS las hojas
 * de un Spreadsheet según el objeto de tablas recibido.
 * Llamada desde 03_poblarSyllabus.gs DESPUÉS de escribir datos reales.
 *
 * ¿Por qué aquí y no en setupSidepTables?
 *   insertCheckboxes() sobre celdas vacías hace que getLastRow() retorne > 1,
 *   engañando a tablasVacias_() y al modo SAFE de los pobladores.
 *   Al llamar esta función post-escritura, las celdas ya tienen valores reales.
 *
 * @param {Spreadsheet} ss     — Spreadsheet destino (CORE, ADMIN o BI)
 * @param {Object}      tables — objeto de tablas del CONFIG (ej: ADMIN_TABLES)
 */
function aplicarFormatosAutomaticos_(ss, tables) {
  Object.keys(tables).forEach(function(nombre) {
    var hoja = ss.getSheetByName(nombre);
    if (!hoja) return;
    aplicarFormatosHoja_(hoja, tables[nombre]);
    Logger.log("    🎨 Formatos aplicados: " + nombre);
  });
}

/**
 * Aplica formatos a las columnas de una hoja según convención de nombre de columna.
 * Llamada desde configurarTablas_() en 01_setupSidepTables.gs y desde
 * aplicarFormatosAutomaticos_() en este archivo.
 *
 * Convenciones que disparan formato automático:
 *   Is*        → Checkbox  (booleano visual en Sheets)
 *   *Date      → Fecha     (yyyy-MM-dd)
 *   *At        → Datetime  (yyyy-MM-dd HH:mm)
 *   *Count     → Entero    (#,##0)
 *   *Order     → Entero    (#,##0)
 *
 * Solo aplica a filas de datos (fila 2 en adelante).
 * Seguro de ejecutar múltiples veces — sobreescribe el mismo formato.
 *
 * @param {Sheet}    hoja — hoja de Google Sheets
 * @param {string[]} cols — array de nombres de columnas (encabezado fila 1)
 */
function aplicarFormatosHoja_(hoja, cols) {
  var maxRows = Math.max(hoja.getMaxRows() - 1, 1);
  cols.forEach(function(col, i) {
    var colNum = i + 1;
    var rango  = hoja.getRange(2, colNum, maxRows, 1);
    if      (/^Is[A-Z]/.test(col))        rango.insertCheckboxes();
    else if (/Date$/.test(col))           rango.setNumberFormat("yyyy-MM-dd");
    else if (/At$/.test(col))            rango.setNumberFormat("yyyy-MM-dd HH:mm");
    else if (/Count$|Order$/.test(col))  rango.setNumberFormat("#,##0");
  });
}

/**
 * Escritura masiva en batch — respeta encabezado en fila 1.
 * NUNCA usa loops individuales de celdas (preserva cuota de API de Sheets).
 *
 * FIX v3.6.1: limpia filas antiguas ANTES de escribir.
 * Evita datos basura cuando el nuevo dataset es menor al anterior
 * (ej: al hacer force en poblarConfiguraciones con menos registros que antes).
 *
 * @param {Spreadsheet} ss        — Spreadsheet destino
 * @param {string}      tableName — nombre de la hoja destino
 * @param {Array[]}     rows      — array de arrays con los datos (sin encabezado)
 */
function escribirDatos(ss, tableName, rows) {
  if (!rows || rows.length === 0) return;
  var sheet = ss.getSheetByName(tableName);
  if (!sheet) {
    Logger.log("  ⚠️  Tabla no encontrada: " + tableName + " — ¿ejecutaste setupSidepTables()?");
    return;
  }
  // Limpiar filas antiguas ANTES de escribir (FIX v3.6.1)
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log("    🌱 " + tableName + " → " + rows.length + " registros");
}