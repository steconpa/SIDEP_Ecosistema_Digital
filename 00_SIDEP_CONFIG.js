/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 00_SIDEP_CONFIG.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Parámetros globales del sistema (SIDEP_CONFIG).
 *   UNA sola variable. Nada más.
 *
 * REGLA DE ORO — SRP por archivo:
 *   00_SIDEP_CONFIG.gs           → parámetros del sistema       ← este archivo
 *   01_SIDEP_TABLES.gs           → modelo de datos core/admin/bi
 *   02_SIDEP_HELPERS.gs          → infraestructura reutilizable (Drive, Sheets, utils)
 *   03_SIDEP_validarEsquema.gs   → validaciones de esquema en arranque
 *   04_SIDEP_STAGING_TABLES.gs   → modelo de datos staging (STG_*)
 *   12c_operacionesCatalogos.gs  → lógica de negocio sobre catálogos
 *
 * SCOPE COMPARTIDO EN GAS:
 *   Todos los archivos del mismo proyecto Apps Script comparten scope global.
 *   Una constante definida aquí es visible en cualquier otro archivo
 *   sin necesidad de imports. No duplicar nombres entre archivos.
 *
 * ESTRUCTURA DEL PROYECTO (orden de ejecución en onboarding):
 *
 *   ── Infraestructura compartida (no se ejecutan solos) ──────────────────
 *   00_SIDEP_CONFIG.gs           ← este archivo — parámetros del sistema
 *   01_SIDEP_TABLES.gs           ← modelo de datos core/admin/bi (COLUMN_TYPES)
 *   02_SIDEP_HELPERS.gs          ← infraestructura reutilizable (Drive, Sheets, utils)
 *   03_SIDEP_validarEsquema.gs   ← validaciones de esquema en arranque
 *   04_SIDEP_STAGING_TABLES.gs   ← modelo de datos staging (STG_*)
 *
 *   ── Scripts ejecutables — onboarding inicial ───────────────────────────
 *   10_inicializarEcosistema.gs  → crea estructura de carpetas en Google Drive
 *   11_setupSidepTables.gs       → crea los 3 Spreadsheets, hojas y Tablas nativas
 *   12_poblarConfiguraciones.gs  → llena tablas _CFG_* con catálogos base
 *   12b_poblarAperturas.gs       → registra decisiones de SIDEP en APERTURA_PLAN
 *   12c_operacionesCatalogos.gs  → mantenimiento de catálogos + aplicarTiposPostBootstrap()
 *   13_poblarSyllabus.gs         → llena _CFG_SYLLABUS con temarios (57 materias)
 *   14_crearAulas.gs             → lee APERTURA_PLAN y crea aulas en Classroom
 *   15_estructurarAulas.gs       → crea Topics por semana en cada aula
 *   16_importarDocentes.gs       → asigna docentes a deployments vía Classroom API
 *   16b_sincronizarDocentes.gs   → sincroniza estado de invitaciones docentes
 *   17_importarEstudiantes.gs    → carga masiva de Students y Enrollments
 *   18_notificarEstudiantes.gs   → envío de notificaciones a estudiantes
 *   19_setupStagingSheets.gs     → crea SIDEP_04_STAGING_SETUP, SIDEP_STAGING_APERTURAS
 *                                    y SIDEP_STG_DOCENTES (09_STAGING_ACADEMICO)
 *
 *   ── Capa de datos staging (repo / service / jobs / menu) ───────────────
 *   24_repo_staging.gs              → acceso a datos de SIDEP_04_STAGING_SETUP (CERO negocio)
 *   24b_repo_staging_academico.gs   → acceso a datos de SIDEP_STG_DOCENTES (CERO negocio)
 *   30_service_institution_setup.gs → valida y promueve STG_INSTITUTION_SETUP
 *   31_service_aperturas_staging.gs → valida y promueve STG_APERTURAS
 *   32_service_docentes_staging.gs  → valida y promueve STG_DOCENTES / STG_ASIGNACIONES
 *   40_job_procesarStgAperturas.gs  → job — procesa STG_APERTURAS
 *   41_staging_setup_menu.gs        → menú onOpen de SIDEP_04_STAGING_SETUP
 *   42_job_procesarStgDocentes.gs   → job — procesa STG_DOCENTES / STG_ASIGNACIONES
 *   52_menu_staging_docentes.gs     → menú onOpen de SIDEP_STG_DOCENTES
 *
 *   ── Scripts ejecutables — operación continua ───────────────────────────
 *   18_semaforo.gs               → trigger semanal — motor de riesgo académico
 *   99_orquestador.gs            → punto de entrada único para onboarding y diagnóstico
 *
 *   ORDEN DE ONBOARDING (via 99_orquestador.gs):
 *     paso 1:   11_setupSidepTables()          → estructura + Tablas nativas + tipos simples
 *     paso 2:   12_poblarConfiguraciones()     → catálogos _CFG_*
 *     paso 2.5: 12c_aplicarTiposPostBootstrap()→ DROPDOWN_CAT con valores reales
 *     paso 3:   13_poblarSyllabus()            → temarios
 *     paso 4:   14_crearAulas()               → aulas en Classroom
 *     paso 5:   15_estructurarAulas()          → topics por semana
 *     paso 6:   16_importarDocentes()          → asignación de docentes
 *     paso 7:   17_importarEstudiantes()       → carga de estudiantes
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
 * MODELO FLEXIBLE DE APERTURAS (v4.0.0 — cambio arquitectural mayor):
 *   ANTES (v3.x): el sistema decidía qué aulas abrir filtrando
 *     _CFG_SUBJECTS.DirStartMoment === momentCode. Asumía estructura lineal fija.
 *   AHORA (v4.0): Carlos decide qué abre en cada cohorte/momento.
 *     Esa decisión se registra en APERTURA_PLAN. 04_crearAulas_v2.gs la lee.
 *     DirStartMoment y similares son ahora INFORMATIVOS, no filtros de control.
 *
 * VERSIONADO:
 *   modelVersion en SIDEP_CONFIG versiona el MODELO DE DATOS (esquema de tablas).
 *   Cada archivo .gs tiene su propio número de versión en su encabezado,
 *   que versiona la LÓGICA del script. Ambos números son independientes.
 *   Al cambiar el esquema de una tabla: actualizar modelVersion + tablas en Sheets.
 *
 * VERSIÓN DEL MODELO: 4.2.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-27
 *
 * CAMBIOS v4.2.0 vs v4.1.0 — REFACTORING SRP:
 *   - 00_SIDEP_CONFIG.gs: ahora contiene SOLO SIDEP_CONFIG.
 *   - NUEVO 01_SIDEP_TABLES.gs: contiene CORE_TABLES, ADMIN_TABLES, BI_TABLES,
 *     MOMENT_ORDER, MOMENTOS_DIR, MOMENTOS_ART, PROGRAMAS_ESPECIFICOS,
 *     TODOS_LOS_PROGRAMAS.
 *   - NUEVO 02_SIDEP_HELPERS.gs: contiene todos los helpers de infraestructura
 *     (Drive, Sheets, utils) + _backupHoja_, _restaurarHoja_, _leerHoja_,
 *     _escribirEnBatch_ promovidos desde 02c + nuevo escribirDatosSeguro().
 *   - 02c_operacionesCatalogos.gs: conserva SOLO lógica de negocio de catálogos.
 *     Los helpers genéricos de Sheet que tenía ahora viven en 02_SIDEP_HELPERS.gs.
 *   - var → const en todas las declaraciones de constantes (GAS V8 lo soporta).
 *   Sin cambios de schema ni de datos — migración 100% no destructiva.
 *
 * CAMBIOS v4.1.0 vs v4.0.1:
 *   - MODIFICADA TeacherAssignments: +2 columnas (InvitationID, InvitationStatus).
 *   - NUEVO StatusType INVITATION en _CFG_STATUSES.
 *   - 06_importarDocentes.gs v8.0 usa Invitations.create() en lugar de Teachers.create().
 *
 * CAMBIOS v4.0.1 vs v4.0.0:
 *   - FIX: getSpreadsheetByName() usa getRootFolderSafe() (O(1) vs O(n)).
 *
 * CAMBIOS v4.0.0 vs v3.6.1:
 *   - NUEVA tabla CORE: APERTURA_PLAN.
 *   - MODIFICADA _CFG_SUBJECTS: +2 columnas (CicloDir, CicloArt). Total 17→19 cols.
 *   - MODIFICADA Enrollments: +1 columna AperturaID.
 *   - NUEVO StatusType APERTURA en _CFG_STATUSES.
 *   - 04_crearAulas_v2.gs reemplaza 04_crearAulas.gs.
 *   - 02b_poblarAperturas.gs (NUEVO).
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
// ÚNICA RESPONSABILIDAD: Parámetros globales del ecosistema.
// Modificar aquí afecta a TODOS los scripts del proyecto.
// ─────────────────────────────────────────────────────────────

const SIDEP_CONFIG = {
  // Estructura de carpetas en Google Drive
  rootFolderName:            "00_SIDEP_ECOSISTEMA_DIGITAL",
  dbFolderName:              "01_BASES_DE_DATOS_MAESTRAS",
  stagingFolderName:         "08_STAGING_SETUP",
  stagingAcademicoFolderName:"09_STAGING_ACADEMICO",

  // Nombres de los Spreadsheets (no cambiar en producción sin migración de datos)
  files: {
    core:            "SIDEP_01_CORE_ACADEMICO",
    admin:           "SIDEP_02_GESTION_ADMIN",
    bi:              "SIDEP_03_BI_DASHBOARD",
    staging:         "SIDEP_04_STAGING_SETUP",
    stagingAperturas:"SIDEP_STAGING_APERTURAS",
    stagingDocentes:    "SIDEP_STG_DOCENTES",
    stagingEstudiantes: "SIDEP_STG_ESTUDIANTES"
  },

  // Estilo de encabezados — aplica a todas las tablas via configurarTablas_()
  headerStyle: {
    background: "#1a3c5e",
    fontColor:  "#ffffff",
    fontWeight: "bold"
  },

  // Timezone oficial del sistema — America/Bogota (UTC-5).
  // CRÍTICO: todas las fechas del Semáforo deben usar este timezone.
  // Usar nowSIDEP() (en 02_SIDEP_HELPERS.gs) en lugar de new Date() directo.
  timezone: "America/Bogota",

  // Campus por defecto (Fase 1 — sede única Bogotá)
  defaultCampus: "BOGOTA",

  // Versión actual del modelo de datos.
  // Incrementar cuando cambie el schema de cualquier tabla.
  // Independiente de las versiones de cada script individual.
  modelVersion: "4.2.0",

  // Claves centralizadas de ScriptProperties — evita strings mágicos dispersos.
  // Todos los scripts deben leer/escribir ScriptProperties usando estas claves.
  propKeys: {
    rootFolderId:       "sidep_rootFolderId",        // ID de la carpeta raíz en caché O(1)
    stagingAperturasId: "sidep_stagingAperturasId",  // ID del SS SIDEP_STAGING_APERTURAS
    stagingDocentesId:      "sidep_stagingDocentesId",      // ID del SS SIDEP_STG_DOCENTES
    stagingEstudiantesId:   "sidep_stagingEstudiantesId"    // ID del SS SIDEP_STG_ESTUDIANTES
  }
};
