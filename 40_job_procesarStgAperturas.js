/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 40_job_procesarStgAperturas.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Procesar STG_APERTURAS pendientes y promoverlas hacia
 *   APERTURA_PLAN con validación y trazabilidad.
 *
 * NOTA:
 *   Esta primera versión es un job manual/automatizable, pero aún no
 *   reemplaza el flujo productivo vigente de 12b_poblarAperturas.gs.
 * ============================================================
 */

function procesarStgAperturasPendientes(options) {
  const opts = options || {};
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(15000)) {
    throw new Error("⚠️ Lock ocupado. Otro proceso está trabajando STG_APERTURAS.");
  }

  const inicio = Date.now();
  const ahora = nowSIDEP();
  const ejecutor = Session.getEffectiveUser().getEmail();
  const resumen = { procesadas: 0, promovidas: 0, errores: 0, omitidas: 0 };

  try {
    Logger.log("════════════════════════════════════════════════");
    Logger.log("⚙️ SIDEP — procesarStgAperturasPendientes");
    Logger.log("   Ejecutor : " + ejecutor);
    Logger.log("════════════════════════════════════════════════");

    const pendientes = leerStgAperturasPendientes({
      requireApproved: opts.requireApproved !== false
    });

    if (pendientes.datos.length === 0) {
      Logger.log("ℹ️  No hay aperturas pendientes por procesar.");
      return;
    }

    const ctx = construirContextoValidacionAperturasStaging_();

    pendientes.datos.forEach(function(row) {
      const solicitud = construirSolicitudAperturaDesdeStaging_(row, pendientes.idx);
      resumen.procesadas++;

      try {
        const validacion = validarSolicitudAperturaStaging(solicitud, ctx);
        if (!validacion.ok) {
          const msg = validacion.errores.join(" | ");
          actualizarStgApertura(solicitud.stageAperturaId, {
            StageStatus: "ERROR",
            ValidationMessage: msg,
            ProcessedAt: ahora,
            ProcessedBy: ejecutor
          });
          registrarStgAperturaLog({
            stageAperturaId: solicitud.stageAperturaId,
            action: "VALIDATE",
            result: "ERROR",
            message: msg,
            snapshotJson: JSON.stringify(solicitud)
          });
          resumen.errores++;
          return;
        }

        const promoted = promoverSolicitudAperturaStaging(solicitud);

        actualizarStgApertura(solicitud.stageAperturaId, {
          StageStatus: "PROMOTED",
          ValidationMessage: "",
          TargetAperturaID: promoted.aperturaId || "",
          TargetDeploymentID: promoted.deploymentId || "",
          ProcessedAt: ahora,
          ProcessedBy: ejecutor
        });

        registrarStgAperturaLog({
          stageAperturaId: solicitud.stageAperturaId,
          action: "PROMOTE",
          result: "SUCCESS",
          message: promoted.actionApplied,
          snapshotJson: JSON.stringify(solicitud)
        });

        resumen.promovidas++;
      } catch (e) {
        actualizarStgApertura(solicitud.stageAperturaId, {
          StageStatus: "ERROR",
          ValidationMessage: e.message,
          ProcessedAt: ahora,
          ProcessedBy: ejecutor
        });
        registrarStgAperturaLog({
          stageAperturaId: solicitud.stageAperturaId,
          action: "PROCESS",
          result: "ERROR",
          message: e.message,
          snapshotJson: JSON.stringify(solicitud)
        });
        resumen.errores++;
      }
    });

    const dur = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log("\n════════════════════════════════════════════════");
    Logger.log("✅ Job completado en " + dur + "s");
    Logger.log("   Procesadas : " + resumen.procesadas);
    Logger.log("   Promovidas : " + resumen.promovidas);
    Logger.log("   Errores    : " + resumen.errores);
    Logger.log("════════════════════════════════════════════════");
  } finally {
    lock.releaseLock();
  }
}
