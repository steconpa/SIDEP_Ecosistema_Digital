/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 16_importarDocentes.gs
 * Versión: 9.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Punto de entrada legacy — delega a procesarStgDocentes().
 *   Toda la lógica de negocio vive en:
 *     32_service_docentes_staging.gs  → validación y promoción
 *     42_job_procesarStgDocentes.gs   → orquestación y LockService
 *     24b_repo_staging_academico.gs   → acceso a STG_DOCENTES / STG_ASIGNACIONES
 *
 * FLUJO (v9):
 *   importarDocentes() → procesarStgDocentes()
 *
 *   El equipo SIDEP carga los datos en SIDEP_STG_DOCENTES (hojas
 *   STG_DOCENTES y STG_ASIGNACIONES), aprueba las filas
 *   (ApprovalStatus = APPROVED) y ejecuta desde el menú o aquí.
 *
 * CAMBIOS v9.0.0 vs v8.x:
 *   - Eliminados DOCENTES_DATA y ASIGNACIONES_DATA (datos hardcodeados).
 *   - Eliminadas todas las funciones privadas _*_ (movidas a 32_service).
 *   - importarDocentes() ahora es un wrapper de procesarStgDocentes().
 *   - Constantes locales movidas a 32_service_docentes_staging.gs.
 *
 * CAMBIOS v8.x:
 *   - FIX-H: Invitations.create() en lugar de Teachers.create() (sin admin).
 *   - FIX-I: +InvitationID, +InvitationStatus en TeacherAssignments.
 *   - Retry con backoff exponencial en Classroom API.
 *
 * DEPENDE DE:
 *   42_job_procesarStgDocentes.gs → procesarStgDocentes()
 *
 * @see https://www.googleapis.com/auth/spreadsheets
 * @see https://www.googleapis.com/auth/classroom.courses
 * @see https://www.googleapis.com/auth/classroom.rosters
 * @see https://www.googleapis.com/auth/script.scriptapp
 * ============================================================
 */

/**
 * Wrapper de compatibilidad → procesarStgDocentes().
 *
 * Para ejecutar directamente:
 *   importarDocentes()                → procesa lote APPROVED/PENDING
 *   importarDocentes({ dryRun:true }) → solo valida, sin escribir
 *
 * PREREQUISITO: cargar datos en SIDEP_STG_DOCENTES
 *   (hojas STG_DOCENTES y STG_ASIGNACIONES) y marcar
 *   ApprovalStatus = APPROVED en las filas a procesar.
 *   Ejecutar setupStagingDocentesSheets() si es la primera vez.
 */
function importarDocentes(options) {
  procesarStgDocentes(options || {});
}
