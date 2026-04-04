/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 17_importarEstudiantes.gs
 * Versión: 2.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Punto de entrada público para el proceso de importación de estudiantes.
 *   Delega la lógica a los nuevos módulos de staging:
 *
 *   43_job_procesarStgEstudiantes.gs → procesarStgEstudiantes()
 *                                      procesarStgMatriculas()
 *
 * CAMBIOS v2.0.0 vs v1.1.0:
 *   - Se eliminó el hardcode de ESTUDIANTES_DATA (39 estudiantes de MR26/C1M2).
 *   - La importación ahora lee STG_ESTUDIANTES y STG_MATRICULAS en el
 *     Spreadsheet SIDEP_STG_ESTUDIANTES (proceso de staging completo).
 *   - El staff ingresa los datos en el staging, los aprueba, y el sistema
 *     los promueve a Students + Enrollments de manera auditada.
 *   - Se conserva la función pública importarEstudiantes() como wrapper
 *     para compatibilidad con el orquestador (99_orquestador.gs).
 *
 * FLUJO NUEVO:
 *   1. Staff carga datos en SIDEP_STG_ESTUDIANTES:
 *      a. STG_ESTUDIANTES → datos del estudiante (REGISTER / UPDATE / DEACTIVATE)
 *      b. STG_MATRICULAS  → matrículas a aulas   (ENROLL / DROP)
 *   2. Staff pone ApprovalStatus = APPROVED en las filas listas.
 *   3. Coordinación ejecuta desde el menú SIDEP Estudiantes:
 *      "Procesar solicitudes de estudiantes" → Students
 *      "Procesar matriculas a aulas"         → Enrollments + Classroom
 *   4. El sistema envía automáticamente el email de bienvenida con horario y links.
 *
 * PARA SETUP INICIAL:
 *   Ejecutar setupStagingEstudiantesSheets() desde 19_setupStagingSheets.gs
 *   para crear el Spreadsheet SIDEP_STG_ESTUDIANTES.
 * ============================================================
 */


/**
 * Wrapper público — procesa STG_ESTUDIANTES → Students.
 * Llamado desde 99_orquestador.gs en el paso de onboarding de estudiantes.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] — validar sin escribir
 */
function importarEstudiantes(options) {
  procesarStgEstudiantes(options || {});
}


/**
 * Wrapper público — procesa STG_MATRICULAS → Enrollments + Classroom.
 * Llama automáticamente a notificarEstudiantes() al finalizar.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] — validar sin escribir
 */
function importarMatriculas(options) {
  procesarStgMatriculas(options || {});
}


/**
 * Diagnóstico de estado sin modificar nada.
 * Muestra counts en Logger: Students, Enrollments y estado de STG_MATRICULAS.
 */
function diagnosticoEstudiantes() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — diagnosticoEstudiantes");
  Logger.log("════════════════════════════════════════════════");

  try {
    var adminSS = getSpreadsheetByName("admin");

    var hojaStudents = adminSS.getSheetByName("Students");
    var hojaEnr      = adminSS.getSheetByName("Enrollments");

    var stuRows = hojaStudents && hojaStudents.getLastRow() > 1
      ? hojaStudents.getLastRow() - 1 : 0;
    var enrRows = hojaEnr && hojaEnr.getLastRow() > 1
      ? hojaEnr.getLastRow() - 1 : 0;

    Logger.log("  Students    : " + stuRows + " filas");
    Logger.log("  Enrollments : " + enrRows + " filas");

    if (hojaEnr && hojaEnr.getLastRow() > 1) {
      var enc   = hojaEnr.getRange(1, 1, 1, hojaEnr.getLastColumn()).getValues()[0];
      var iSt   = enc.indexOf("EnrollmentStatusCode");
      var datos = hojaEnr.getRange(2, 1, hojaEnr.getLastRow() - 1, hojaEnr.getLastColumn()).getValues();
      var porSt = {};
      datos.forEach(function(f) {
        var st = String(f[iSt] || "SIN_STATUS").trim();
        porSt[st] = (porSt[st] || 0) + 1;
      });
      Logger.log("\n  Enrollments por EnrollmentStatusCode:");
      Object.keys(porSt).sort().forEach(function(k) {
        Logger.log("    " + k + ": " + porSt[k]);
      });
    }

  } catch (e) {
    Logger.log("ERROR: " + e.message);
  }

  Logger.log("════════════════════════════════════════════════");
}
