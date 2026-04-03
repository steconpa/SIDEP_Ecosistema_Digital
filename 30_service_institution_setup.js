/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 30_service_institution_setup.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Validar y promover STG_INSTITUTION_SETUP hacia _CFG_INSTITUTION.
 * ============================================================
 */

function validarSolicitudesInstitucionSetup() {
  const mem      = getTableData("staging", "STG_INSTITUTION_SETUP");
  const ahora    = nowSIDEP();
  const ejecutor = Session.getEffectiveUser().getEmail();
  const resumen  = { revisadas: 0, ok: 0, errores: 0 };

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔎 validarSolicitudesInstitucionSetup");
  Logger.log("   Filas staging: " + mem.datos.length);
  Logger.log("   Ejecuta     : " + ejecutor);
  Logger.log("════════════════════════════════════════════════");

  mem.datos.forEach(function(row) {
    if (filaInstitutionSetupVacia_(row)) return;

    const solicitud = normalizarSolicitudInstitucion_(row, mem.idx, ahora, ejecutor);
    const validacion = validarSolicitudInstitucion_(solicitud);
    resumen.revisadas++;

    Logger.log(
      "  • [" + resumen.revisadas + "] " + solicitud.stageInstitutionId +
      " | " + (solicitud.requestedAction || "SIN_ACTION") +
      " | " + (solicitud.institutionShortName || solicitud.institutionLegalName || "SIN_NOMBRE")
    );

    row[mem.idx["StageInstitutionID"]] = solicitud.stageInstitutionId;
    row[mem.idx["RequestedBy"]]        = solicitud.requestedBy;
    row[mem.idx["RequestedAt"]]        = solicitud.requestedAt;
    row[mem.idx["ApprovalStatus"]]     = solicitud.approvalStatus;

    if (validacion.ok) {
      row[mem.idx["StageStatus"]]       = "VALIDATED";
      row[mem.idx["ValidationMessage"]] = "OK";
      resumen.ok++;
      Logger.log("    ✅ Validada");
      registrarStagingSetupLog({
        stageEntityType: "INSTITUTION",
        stageRecordId: solicitud.stageInstitutionId,
        action: "VALIDATE",
        result: "SUCCESS",
        message: "Solicitud validada"
      });
    } else {
      row[mem.idx["StageStatus"]]       = "ERROR";
      row[mem.idx["ValidationMessage"]] = validacion.errores.join(" | ");
      resumen.errores++;
      Logger.log("    ❌ Error validación: " + validacion.errores.join(" | "));
      registrarStagingSetupLog({
        stageEntityType: "INSTITUTION",
        stageRecordId: solicitud.stageInstitutionId,
        action: "VALIDATE",
        result: "ERROR",
        message: validacion.errores.join(" | ")
      });
    }
  });

  _escribirEnBatch_(mem.hoja, mem);
  Logger.log(
    "📊 Validación completada → revisadas: " + resumen.revisadas +
    " | ok: " + resumen.ok + " | errores: " + resumen.errores
  );
  mostrarToastStagingSetup_(
    "Institucion setup: " + resumen.ok + " OK, " + resumen.errores + " con error"
  );
}


function procesarSolicitudesInstitucionSetup() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error("⚠️ Lock ocupado. Otro proceso está trabajando solicitudes de institución.");
  }

  const ahora    = nowSIDEP();
  const ejecutor = Session.getEffectiveUser().getEmail();
  const mem      = getTableData("staging", "STG_INSTITUTION_SETUP");
  const resumen  = { promovidas: 0, errores: 0, omitidas: 0 };

  try {
    const core = ensureInstitutionCoreTable_();
    const coreMem = core.mem;
    let coreChanged = false;

    Logger.log("════════════════════════════════════════════════");
    Logger.log("⚙️ procesarSolicitudesInstitucionSetup");
    Logger.log("   Filas staging : " + mem.datos.length);
    Logger.log("   Filas core    : " + coreMem.datos.length);
    Logger.log("   Core URL      : " + core.ss.getUrl());
    Logger.log("   Ejecuta       : " + ejecutor);
    Logger.log("════════════════════════════════════════════════");

    mem.datos.forEach(function(row) {
      if (filaInstitutionSetupVacia_(row)) return;

      const solicitud = normalizarSolicitudInstitucion_(row, mem.idx, ahora, ejecutor);
      const validacion = validarSolicitudInstitucion_(solicitud);
      const existingCore = buscarInstitucionCore_(coreMem, solicitud);

      Logger.log(
        "  • " + solicitud.stageInstitutionId +
        " | action=" + (solicitud.requestedAction || "SIN_ACTION") +
        " | approval=" + (solicitud.approvalStatus || "SIN_APPROVAL") +
        " | stage=" + (solicitud.stageStatus || "SIN_STAGE") +
        " | target=" + (solicitud.targetInstitutionId || "-") +
        " | existenteCore=" + (existingCore ? "SI" : "NO")
      );

      if (solicitud.stageStatus === "PROMOTED" && existingCore) {
        resumen.omitidas++;
        Logger.log("    ⏭ Omitida: ya estaba promovida y existe en CORE.");
        return;
      }

      if (!validacion.ok) {
        row[mem.idx["StageStatus"]] = "ERROR";
        row[mem.idx["ValidationMessage"]] = validacion.errores.join(" | ");
        row[mem.idx["ProcessedAt"]] = ahora;
        row[mem.idx["ProcessedBy"]] = ejecutor;
        resumen.errores++;
        Logger.log("    ❌ Error validación: " + validacion.errores.join(" | "));
        return;
      }

      if (solicitud.approvalStatus === "REJECTED") {
        row[mem.idx["StageStatus"]] = "ERROR";
        row[mem.idx["ValidationMessage"]] = "Solicitud rechazada. No se procesa.";
        row[mem.idx["ProcessedAt"]] = ahora;
        row[mem.idx["ProcessedBy"]] = ejecutor;
        resumen.omitidas++;
        Logger.log("    ⏭ Omitida: solicitud rechazada.");
        return;
      }

      try {
        const result = promoverInstitucionSetup_(solicitud, coreMem, ahora, ejecutor);
        row[mem.idx["ApprovalStatus"]]     = "APPROVED";
        row[mem.idx["StageStatus"]]        = "PROMOTED";
        row[mem.idx["ValidationMessage"]]  = result.message;
        row[mem.idx["TargetInstitutionID"]] = result.institutionId;
        row[mem.idx["ProcessedAt"]]        = ahora;
        row[mem.idx["ProcessedBy"]]        = ejecutor;
        resumen.promovidas++;
        coreChanged = true;
        Logger.log("    ✅ Promovida: " + result.message + " | InstitutionID=" + result.institutionId);

        registrarStagingSetupLog({
          stageEntityType: "INSTITUTION",
          stageRecordId: solicitud.stageInstitutionId,
          action: "PROMOTE",
          result: "SUCCESS",
          message: result.message
        });
      } catch (e) {
        row[mem.idx["StageStatus"]] = "ERROR";
        row[mem.idx["ValidationMessage"]] = e.message;
        row[mem.idx["ProcessedAt"]] = ahora;
        row[mem.idx["ProcessedBy"]] = ejecutor;
        resumen.errores++;
        Logger.log("    ❌ Error promoción: " + e.message);

        registrarStagingSetupLog({
          stageEntityType: "INSTITUTION",
          stageRecordId: solicitud.stageInstitutionId,
          action: "PROMOTE",
          result: "ERROR",
          message: e.message
        });
      }
    });

    if (coreChanged) {
      Logger.log("💾 Escribiendo _CFG_INSTITUTION en CORE con " + coreMem.datos.length + " fila(s) reales...");
      escribirDatosSeguro(core.ss, "_CFG_INSTITUTION", coreMem.datos);
      compactarInstitutionCore_(core.ss);
    } else {
      Logger.log("ℹ️ _CFG_INSTITUTION no cambió en esta ejecución.");
    }
    _escribirEnBatch_(mem.hoja, mem);
    Logger.log(
      "📊 Proceso completado → promovidas: " + resumen.promovidas +
      " | errores: " + resumen.errores +
      " | omitidas: " + resumen.omitidas
    );

    mostrarToastStagingSetup_(
      "Promovidas: " + resumen.promovidas +
      " | Errores: " + resumen.errores +
      " | Omitidas: " + resumen.omitidas
    );
  } finally {
    lock.releaseLock();
  }
}


function limpiarMensajesInstitucionSetup() {
  const mem = getTableData("staging", "STG_INSTITUTION_SETUP");

  mem.datos.forEach(function(row) {
    const stageStatus = String(row[mem.idx["StageStatus"]] || "").trim();
    if (stageStatus !== "PROMOTED") {
      row[mem.idx["ValidationMessage"]] = "";
      if (!stageStatus) row[mem.idx["StageStatus"]] = "PENDING";
    }
  });

  _escribirEnBatch_(mem.hoja, mem);
  registrarStagingSetupLog({
    stageEntityType: "INSTITUTION",
    stageRecordId: "",
    action: "CLEAN",
    result: "SUCCESS",
    message: "Mensajes limpiados en STG_INSTITUTION_SETUP"
  });
}


function normalizarSolicitudInstitucion_(row, idx, ahora, ejecutor) {
  return {
    stageInstitutionId: String(row[idx["StageInstitutionID"]] || "").trim() || uuid("stginst"),
    requestedAction: String(row[idx["RequestedAction"]] || "").trim().toUpperCase(),
    institutionLegalName: String(row[idx["InstitutionLegalName"]] || "").trim(),
    institutionShortName: String(row[idx["InstitutionShortName"]] || "").trim(),
    taxId: String(row[idx["TaxID"]] || "").trim(),
    address: String(row[idx["Address"]] || "").trim(),
    contactPhone: String(row[idx["ContactPhone"]] || "").trim(),
    educationalDomain: String(row[idx["EducationalDomain"]] || "").trim(),
    contactEmail: String(row[idx["ContactEmail"]] || "").trim().toLowerCase(),
    approvalStatus: String(row[idx["ApprovalStatus"]] || "").trim().toUpperCase() || "SUBMITTED",
    stageStatus: String(row[idx["StageStatus"]] || "").trim().toUpperCase() || "PENDING",
    validationMessage: String(row[idx["ValidationMessage"]] || "").trim(),
    targetInstitutionId: String(row[idx["TargetInstitutionID"]] || "").trim(),
    notes: String(row[idx["Notes"]] || "").trim(),
    requestedBy: String(row[idx["RequestedBy"]] || "").trim() || ejecutor,
    requestedAt: row[idx["RequestedAt"]] || ahora,
    processedAt: row[idx["ProcessedAt"]] || "",
    processedBy: String(row[idx["ProcessedBy"]] || "").trim()
  };
}


function filaInstitutionSetupVacia_(row) {
  return row.every(function(cell) {
    return cell === "" || cell === null;
  });
}


function mostrarToastStagingSetup_(msg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) {
      ss.toast(msg, "SIDEP Setup", 8);
      return;
    }
  } catch (e) {}
  Logger.log("ℹ️ " + msg);
}


function validarSolicitudInstitucion_(s) {
  const errores = [];

  if (["REGISTER", "UPDATE", "DEACTIVATE"].indexOf(s.requestedAction) === -1) {
    errores.push("RequestedAction debe ser REGISTER, UPDATE o DEACTIVATE.");
  }
  if (!s.institutionLegalName) errores.push("InstitutionLegalName es obligatorio.");
  if (!s.institutionShortName) errores.push("InstitutionShortName es obligatorio.");
  if (!s.taxId) errores.push("TaxID es obligatorio.");
  if (!s.address) errores.push("Address es obligatorio.");
  if (!s.contactPhone) errores.push("ContactPhone es obligatorio.");
  if (!s.educationalDomain) errores.push("EducationalDomain es obligatorio.");
  if (!s.contactEmail) errores.push("ContactEmail es obligatorio.");
  if (s.contactEmail && s.contactEmail.indexOf("@") === -1) {
    errores.push("ContactEmail debe contener '@'.");
  }
  if (s.educationalDomain && s.educationalDomain.indexOf(".") === -1) {
    errores.push("EducationalDomain debe parecer un dominio válido.");
  }

  return { ok: errores.length === 0, errores: errores };
}


function promoverInstitucionSetup_(s, coreMem, ahora, ejecutor) {
  const idx = coreMem.idx;
  const existing = buscarInstitucionCore_(coreMem, s);

  if (s.requestedAction === "REGISTER") {
    if (existing && existing.active) {
      existing.row[idx["InstitutionLegalName"]] = s.institutionLegalName;
      existing.row[idx["InstitutionShortName"]] = s.institutionShortName;
      existing.row[idx["TaxID"]]                = s.taxId;
      existing.row[idx["Address"]]              = s.address;
      existing.row[idx["ContactPhone"]]         = s.contactPhone;
      existing.row[idx["EducationalDomain"]]    = s.educationalDomain;
      existing.row[idx["ContactEmail"]]         = s.contactEmail;
      existing.row[idx["UpdatedAt"]]            = ahora;
      existing.row[idx["UpdatedBy"]]            = ejecutor;

      return {
        institutionId: String(existing.row[idx["InstitutionID"]] || ""),
        message: "Institución existente actualizada por idempotencia"
      };
    }

    const institutionId   = uuid("inst");
    const institutionCode = generarInstitutionCode_(s.institutionShortName || s.institutionLegalName, coreMem);

    coreMem.datos.push([
      institutionId,
      institutionCode,
      s.institutionLegalName,
      s.institutionShortName,
      s.taxId,
      s.address,
      s.contactPhone,
      s.educationalDomain,
      s.contactEmail,
      SIDEP_CONFIG.timezone,
      true,
      ahora,
      ejecutor,
      ahora,
      ejecutor
    ]);

    return { institutionId: institutionId, message: "Institución registrada en _CFG_INSTITUTION" };
  }

  if (!existing) {
    throw new Error("No existe institución objetivo para " + s.requestedAction + ".");
  }

  existing.row[idx["InstitutionLegalName"]] = s.institutionLegalName;
  existing.row[idx["InstitutionShortName"]] = s.institutionShortName;
  existing.row[idx["TaxID"]]                = s.taxId;
  existing.row[idx["Address"]]              = s.address;
  existing.row[idx["ContactPhone"]]         = s.contactPhone;
  existing.row[idx["EducationalDomain"]]    = s.educationalDomain;
  existing.row[idx["ContactEmail"]]         = s.contactEmail;
  existing.row[idx["UpdatedAt"]]            = ahora;
  existing.row[idx["UpdatedBy"]]            = ejecutor;

  if (s.requestedAction === "DEACTIVATE") {
    existing.row[idx["IsActive"]] = false;
    return {
      institutionId: String(existing.row[idx["InstitutionID"]] || ""),
      message: "Institución desactivada en _CFG_INSTITUTION"
    };
  }

  existing.row[idx["IsActive"]] = true;
  return {
    institutionId: String(existing.row[idx["InstitutionID"]] || ""),
    message: "Institución actualizada en _CFG_INSTITUTION"
  };
}


function buscarInstitucionCore_(coreMem, s) {
  const idx = coreMem.idx;
  let found = null;

  coreMem.datos.forEach(function(row, i) {
    const institutionId = String(row[idx["InstitutionID"]] || "").trim();
    const taxId         = String(row[idx["TaxID"]] || "").trim();
    const active        = row[idx["IsActive"]] === true;

    if (s.targetInstitutionId && institutionId === s.targetInstitutionId) {
      found = { rowIndex: i, row: row, active: active };
      return;
    }
    if (!found && taxId && taxId === s.taxId) {
      found = { rowIndex: i, row: row, active: active };
    }
  });

  return found;
}


function diagnosticoInstitucionSetup() {
  const stg = getTableData("staging", "STG_INSTITUTION_SETUP");
  const core = ensureInstitutionCoreTable_();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🧪 diagnosticoInstitucionSetup");
  Logger.log("   STAGING URL : " + stg.ss.getUrl());
  Logger.log("   CORE URL    : " + core.ss.getUrl());
  Logger.log("   STAGING filas reales: " + stg.datos.length);
  Logger.log("   CORE filas reales   : " + core.mem.datos.length);
  Logger.log("════════════════════════════════════════════════");

  stg.datos.forEach(function(row, i) {
    Logger.log(
      "  STG[" + (i + 1) + "] " +
      String(row[stg.idx["StageInstitutionID"]] || "").trim() +
      " | " + String(row[stg.idx["RequestedAction"]] || "").trim() +
      " | " + String(row[stg.idx["InstitutionShortName"]] || "").trim() +
      " | stage=" + String(row[stg.idx["StageStatus"]] || "").trim() +
      " | target=" + String(row[stg.idx["TargetInstitutionID"]] || "").trim()
    );
  });

  core.mem.datos.forEach(function(row, i) {
    Logger.log(
      "  CORE[" + (i + 1) + "] " +
      String(row[core.mem.idx["InstitutionID"]] || "").trim() +
      " | " + String(row[core.mem.idx["InstitutionCode"]] || "").trim() +
      " | " + String(row[core.mem.idx["InstitutionShortName"]] || "").trim() +
      " | NIT=" + String(row[core.mem.idx["TaxID"]] || "").trim()
    );
  });
}


function generarInstitutionCode_(label, coreMem) {
  const base = String(label || "INSTITUTION")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 16) || "INSTITUTION";

  const idx = coreMem.idx["InstitutionCode"];
  const existing = {};
  coreMem.datos.forEach(function(row) {
    const code = String(row[idx] || "").trim();
    if (code) existing[code] = true;
  });

  if (!existing[base]) return base;

  let i = 2;
  while (existing[base + "_" + i]) i++;
  return base + "_" + i;
}


function ensureInstitutionCoreTable_() {
  const coreSS = getSpreadsheetByName("core");
  let hoja = coreSS.getSheetByName("_CFG_INSTITUTION");

  if (!hoja) {
    hoja = coreSS.insertSheet("_CFG_INSTITUTION");
    const cols = CORE_TABLES["_CFG_INSTITUTION"];
    hoja.getRange(1, 1, 1, cols.length).setValues([cols])
        .setBackground(SIDEP_CONFIG.headerStyle.background)
        .setFontColor(SIDEP_CONFIG.headerStyle.fontColor)
        .setFontWeight(SIDEP_CONFIG.headerStyle.fontWeight);
    hoja.setFrozenRows(1);
    hoja.autoResizeColumns(1, cols.length);
    try {
      registrarTablasSheetsAPI_(coreSS, { "_CFG_INSTITUTION": CORE_TABLES["_CFG_INSTITUTION"] }, false);
      aplicarDropdownsCatalogo(coreSS, { "_CFG_INSTITUTION": CORE_TABLES["_CFG_INSTITUTION"] });
    } catch (e) {
      Logger.log("⚠️  _CFG_INSTITUTION creada sin tipado API: " + e.message);
    }
  }

  const mem = _leerHoja_(hoja);
  return { ss: coreSS, hoja: hoja, mem: mem };
}


function compactarInstitutionCore_(coreSS) {
  const hoja = coreSS.getSheetByName("_CFG_INSTITUTION");
  if (!hoja) return;

  const mem = _leerHoja_(hoja);
  const cols = mem.encabezado.length;
  if (cols === 0) return;

  const maxRows = hoja.getMaxRows();
  if (maxRows > 1) {
    hoja.getRange(2, 1, maxRows - 1, cols).clearContent();
  }

  if (mem.datos.length > 0) {
    hoja.getRange(2, 1, mem.datos.length, cols).setValues(mem.datos);
  }

  try {
    sincronizarRangosTablas_(coreSS, { "_CFG_INSTITUTION": CORE_TABLES["_CFG_INSTITUTION"] });
  } catch (e) {
    Logger.log("⚠️  No se pudo resincronizar la tabla nativa de _CFG_INSTITUTION: " + e.message);
  }
}
