/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 31_service_aperturas_staging.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Validar y promover aperturas desde STG_APERTURAS hacia
 *   APERTURA_PLAN sin exponer las maestras a edición humana directa.
 *
 * PRINCIPIO:
 *   STG_APERTURAS captura.
 *   APERTURA_PLAN opera.
 * ============================================================
 */

function construirSolicitudAperturaDesdeStaging_(row, idx) {
  return {
    stageAperturaId: String(row[idx["StageAperturaID"]] || "").trim(),
    institutionCode: String(row[idx["InstitutionCode"]] || "").trim(),
    cohortCode:      String(row[idx["CohortCode"]] || "").trim(),
    momentCode:      String(row[idx["MomentCode"]] || "").trim(),
    subjectCode:     String(row[idx["SubjectCode"]] || "").trim(),
    programCode:     String(row[idx["ProgramCode"]] || "").trim(),
    isTransversal:   row[idx["IsTransversal"]] === true,
    requestedAction: String(row[idx["RequestedAction"]] || "").trim(),
    requestedBy:     String(row[idx["RequestedBy"]] || "").trim(),
    requestedAt:     row[idx["RequestedAt"]] || "",
    approvalStatus:  String(row[idx["ApprovalStatus"]] || "").trim(),
    stageStatus:     String(row[idx["StageStatus"]] || "").trim(),
    validationMessage: String(row[idx["ValidationMessage"]] || "").trim(),
    targetAperturaId:  String(row[idx["TargetAperturaID"]] || "").trim(),
    targetDeploymentId:String(row[idx["TargetDeploymentID"]] || "").trim(),
    notes:           String(row[idx["Notes"]] || "").trim(),
    sourceChannel:   String(row[idx["SourceChannel"]] || "").trim(),
    batchId:         String(row[idx["BatchID"]] || "").trim(),
    processedAt:     row[idx["ProcessedAt"]] || "",
    processedBy:     String(row[idx["ProcessedBy"]] || "").trim()
  };
}


function construirContextoValidacionAperturasStaging_() {
  const cohorts  = getTableData("core", "_CFG_COHORTS");
  const moments  = getTableData("core", "_CFG_MOMENTS");
  const subjects = getTableData("core", "_CFG_SUBJECTS");
  const programs = getTableData("core", "_CFG_PROGRAMS");
  const aperturas = getTableData("core", "APERTURA_PLAN");

  return {
    cohortsActivos: _construirSetActivo_(cohorts, "CohortCode"),
    momentsActivos: _construirSetActivo_(moments, "MomentCode"),
    subjectsActivos: _construirSetActivo_(subjects, "SubjectCode"),
    programsActivos: _construirSetActivo_(programs, "ProgramCode"),
    aperturasMem: aperturas,
    aperturasByKey: _construirMapaAperturas_(aperturas)
  };
}


function validarSolicitudAperturaStaging(solicitud, ctx) {
  const errores = [];
  const key = [
    solicitud.cohortCode,
    solicitud.momentCode,
    solicitud.subjectCode,
    solicitud.programCode
  ].join("|");
  const existente = ctx.aperturasByKey[key] || null;

  if (!solicitud.stageAperturaId) errores.push("StageAperturaID es obligatorio.");
  if (!solicitud.cohortCode)      errores.push("CohortCode es obligatorio.");
  if (!solicitud.momentCode)      errores.push("MomentCode es obligatorio.");
  if (!solicitud.subjectCode)     errores.push("SubjectCode es obligatorio.");
  if (!solicitud.programCode)     errores.push("ProgramCode es obligatorio.");
  if (!solicitud.requestedAction) errores.push("RequestedAction es obligatorio.");

  if (solicitud.cohortCode && !ctx.cohortsActivos[solicitud.cohortCode]) {
    errores.push("CohortCode no existe o está inactivo: " + solicitud.cohortCode);
  }
  if (solicitud.momentCode && !ctx.momentsActivos[solicitud.momentCode]) {
    errores.push("MomentCode no existe o está inactivo: " + solicitud.momentCode);
  }
  if (solicitud.subjectCode && !ctx.subjectsActivos[solicitud.subjectCode]) {
    errores.push("SubjectCode no existe o está inactivo: " + solicitud.subjectCode);
  }
  if (solicitud.programCode && !ctx.programsActivos[solicitud.programCode]) {
    errores.push("ProgramCode no existe o está inactivo: " + solicitud.programCode);
  }

  if (solicitud.isTransversal && solicitud.programCode !== "TRV") {
    errores.push("IsTransversal=true exige ProgramCode='TRV'.");
  }
  if (!solicitud.isTransversal && solicitud.programCode === "TRV") {
    errores.push("ProgramCode='TRV' exige IsTransversal=true.");
  }

  switch (solicitud.requestedAction) {
    case "CREATE":
      if (existente) {
        const status = String(existente.row[ctx.aperturasMem.idx["AperturaStatus"]] || "");
        const depId  = String(existente.row[ctx.aperturasMem.idx["DeploymentID"]] || "");
        if (status === "CANCELADA" && depId) {
          errores.push(
            "CREATE no puede reabrir automáticamente una apertura CANCELADA con DeploymentID."
          );
        }
        // Si la apertura ya existe y no está cancelada, se trata como idempotente.
      }
      break;

    case "UPDATE":
      if (!existente) {
        errores.push("UPDATE requiere una apertura existente en APERTURA_PLAN.");
      }
      break;

    case "CANCEL":
      if (!existente) {
        errores.push("CANCEL requiere una apertura existente en APERTURA_PLAN.");
      }
      break;

    case "REACTIVATE":
      if (!existente) {
        errores.push("REACTIVATE requiere una apertura existente en APERTURA_PLAN.");
      } else {
        const status = String(existente.row[ctx.aperturasMem.idx["AperturaStatus"]] || "");
        const depId  = String(existente.row[ctx.aperturasMem.idx["DeploymentID"]] || "");
        if (status !== "CANCELADA") {
          errores.push("Solo se puede reactivar una apertura CANCELADA.");
        }
        if (depId) {
          errores.push("No se puede reactivar automáticamente una apertura con DeploymentID.");
        }
      }
      break;

    default:
      errores.push("RequestedAction no soportada: " + solicitud.requestedAction);
  }

  return {
    ok: errores.length === 0,
    errores: errores,
    key: key,
    existente: existente
  };
}


function promoverSolicitudAperturaStaging(solicitud) {
  const mem      = getTableData("core", "APERTURA_PLAN");
  const idx      = mem.idx;
  const ahora    = nowSIDEP();
  const ejecutor = Session.getEffectiveUser().getEmail();
  const key      = [
    solicitud.cohortCode,
    solicitud.momentCode,
    solicitud.subjectCode,
    solicitud.programCode
  ].join("|");

  const rowIdx = mem.datos.findIndex(function(row) {
    return _claveApertura_(row, idx) === key;
  });

  if (solicitud.requestedAction === "CREATE") {
    if (rowIdx !== -1) {
      const existente = mem.datos[rowIdx];
      const status = String(existente[idx["AperturaStatus"]] || "");
      const depId  = String(existente[idx["DeploymentID"]] || "");

      if (status === "CANCELADA") {
        if (depId) {
          throw new Error(
            "CREATE no puede reabrir automáticamente una apertura CANCELADA con DeploymentID."
          );
        }

        existente[idx["AperturaStatus"]] = "PENDIENTE";
        existente[idx["Notes"]] = solicitud.notes || "Reactivada desde CREATE en STG_APERTURAS";
        existente[idx["UpdatedAt"]] = ahora;
        existente[idx["UpdatedBy"]] = ejecutor;
        _escribirEnBatch_(mem.hoja, mem);

        return {
          aperturaId: String(existente[idx["AperturaID"]] || ""),
          deploymentId: "",
          actionApplied: "REACTIVATED_FROM_CREATE"
        };
      }

      return {
        aperturaId: String(existente[idx["AperturaID"]] || ""),
        deploymentId: depId,
        actionApplied: "NOOP_EXISTING"
      };
    }

    const nuevaFila = [
      uuid("apr"),
      solicitud.cohortCode,
      solicitud.momentCode,
      solicitud.subjectCode,
      solicitud.programCode,
      solicitud.isTransversal,
      "PENDIENTE",
      "",
      solicitud.requestedBy || ejecutor,
      solicitud.requestedAt || ahora,
      solicitud.notes || "Promovida desde STG_APERTURAS",
      ahora,
      ejecutor,
      ahora,
      ejecutor
    ];
    mem.datos.push(nuevaFila);
    _escribirEnBatch_(mem.hoja, mem);

    return {
      aperturaId: nuevaFila[0],
      deploymentId: "",
      actionApplied: "CREATED"
    };
  }

  if (rowIdx === -1) {
    throw new Error("No existe la apertura a modificar en APERTURA_PLAN.");
  }

  const row = mem.datos[rowIdx];

  switch (solicitud.requestedAction) {
    case "UPDATE":
      row[idx["IsTransversal"]] = solicitud.isTransversal;
      row[idx["Notes"]] = solicitud.notes || row[idx["Notes"]];
      row[idx["UpdatedAt"]] = ahora;
      row[idx["UpdatedBy"]] = ejecutor;
      break;

    case "CANCEL":
      row[idx["AperturaStatus"]] = "CANCELADA";
      row[idx["Notes"]] = solicitud.notes || "Cancelada desde STG_APERTURAS";
      row[idx["UpdatedAt"]] = ahora;
      row[idx["UpdatedBy"]] = ejecutor;
      break;

    case "REACTIVATE":
      row[idx["AperturaStatus"]] = "PENDIENTE";
      row[idx["Notes"]] = solicitud.notes || "Reactivada desde STG_APERTURAS";
      row[idx["UpdatedAt"]] = ahora;
      row[idx["UpdatedBy"]] = ejecutor;
      break;

    default:
      throw new Error("Acción no soportada en promoción: " + solicitud.requestedAction);
  }

  _escribirEnBatch_(mem.hoja, mem);

  return {
    aperturaId: String(row[idx["AperturaID"]] || ""),
    deploymentId: String(row[idx["DeploymentID"]] || ""),
    actionApplied: solicitud.requestedAction
  };
}


function _construirSetActivo_(mem, codeCol) {
  const set = {};
  const iCode = mem.idx[codeCol];
  const iActive = mem.idx["IsActive"];

  mem.datos.forEach(function(row) {
    const code = String(row[iCode] || "").trim();
    const active = typeof iActive === "undefined" ? true : row[iActive] === true;
    if (code && active) set[code] = true;
  });

  return set;
}


function _construirMapaAperturas_(mem) {
  const map = {};
  mem.datos.forEach(function(row, i) {
    const key = _claveApertura_(row, mem.idx);
    if (key) map[key] = { rowIndex: i, row: row };
  });
  return map;
}


function _claveApertura_(row, idx) {
  return [
    String(row[idx["CohortCode"]] || "").trim(),
    String(row[idx["MomentCode"]] || "").trim(),
    String(row[idx["SubjectCode"]] || "").trim(),
    String(row[idx["ProgramCode"]] || "").trim()
  ].join("|");
}
