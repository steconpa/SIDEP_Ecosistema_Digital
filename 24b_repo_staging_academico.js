/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 24b_repo_staging_academico.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Acceso a datos del spreadsheet SIDEP_STG_DOCENTES.
 *   CERO reglas de negocio — solo lectura y escritura en batch.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs  → SIDEP_CONFIG.files.stagingDocentes
 *   02_SIDEP_HELPERS.gs → getTableData(), _leerHoja_(), _escribirEnBatch_()
 *   04_SIDEP_STAGING_TABLES.gs → STAGING_ACADEMICO_TABLES (columnas por nombre)
 *
 * TABLAS:
 *   STG_DOCENTES    → una fila por docente a vincular / actualizar
 *   STG_ASIGNACIONES → una fila por asignación docente × aula
 *   STG_DOCENTES_LOG → auditoría de cada operación (escritura exclusiva del sistema)
 * ============================================================
 */


// ── Lectura ──────────────────────────────────────────────────

/**
 * Lee STG_DOCENTES, opcionalmente filtrando por StageStatus.
 *
 * @param {object} [options]
 * @param {string} [options.stageStatus] — si se pasa, filtra filas con ese estado
 * @returns {{ ss, hoja, encabezado, idx, datos }}
 */
function leerStgDocentes(options) {
  const opts   = options || {};
  const filter = opts.stageStatus || null;
  const mem    = getTableData("stagingDocentes", "STG_DOCENTES");

  if (filter) {
    mem.datos = mem.datos.filter(function(row) {
      return String(row[mem.idx["StageStatus"]] || "").trim() === filter;
    });
  }

  return mem;
}


/**
 * Lee STG_ASIGNACIONES, opcionalmente filtrando por StageStatus.
 *
 * @param {object} [options]
 * @param {string} [options.stageStatus]
 * @returns {{ ss, hoja, encabezado, idx, datos }}
 */
function leerStgAsignaciones(options) {
  const opts   = options || {};
  const filter = opts.stageStatus || null;
  const mem    = getTableData("stagingDocentes", "STG_ASIGNACIONES");

  if (filter) {
    mem.datos = mem.datos.filter(function(row) {
      return String(row[mem.idx["StageStatus"]] || "").trim() === filter;
    });
  }

  return mem;
}


// ── Escritura — actualización de fila individual ─────────────

/**
 * Actualiza columnas de una fila en STG_DOCENTES por StageDocenteID.
 *
 * @param {string} stageDocenteId
 * @param {object} patch — { ColName: value, ... }
 */
function actualizarStgDocente(stageDocenteId, patch) {
  const mem = getTableData("stagingDocentes", "STG_DOCENTES");
  const iId = mem.idx["StageDocenteID"];
  const id  = String(stageDocenteId || "").trim();

  if (!id) throw new Error("actualizarStgDocente: StageDocenteID es obligatorio.");

  const rowIdx = mem.datos.findIndex(function(row) {
    return String(row[iId] || "").trim() === id;
  });

  if (rowIdx === -1) {
    throw new Error("actualizarStgDocente: StageDocenteID no encontrado → " + id);
  }

  Object.keys(patch || {}).forEach(function(key) {
    if (typeof mem.idx[key] !== "undefined") {
      mem.datos[rowIdx][mem.idx[key]] = patch[key];
    }
  });

  _escribirEnBatch_(mem.hoja, mem);
  return mem.datos[rowIdx];
}


/**
 * Actualiza columnas de una fila en STG_ASIGNACIONES por StageAsignacionID.
 *
 * @param {string} stageAsignacionId
 * @param {object} patch — { ColName: value, ... }
 */
function actualizarStgAsignacion(stageAsignacionId, patch) {
  const mem = getTableData("stagingDocentes", "STG_ASIGNACIONES");
  const iId = mem.idx["StageAsignacionID"];
  const id  = String(stageAsignacionId || "").trim();

  if (!id) throw new Error("actualizarStgAsignacion: StageAsignacionID es obligatorio.");

  const rowIdx = mem.datos.findIndex(function(row) {
    return String(row[iId] || "").trim() === id;
  });

  if (rowIdx === -1) {
    throw new Error("actualizarStgAsignacion: StageAsignacionID no encontrado → " + id);
  }

  Object.keys(patch || {}).forEach(function(key) {
    if (typeof mem.idx[key] !== "undefined") {
      mem.datos[rowIdx][mem.idx[key]] = patch[key];
    }
  });

  _escribirEnBatch_(mem.hoja, mem);
  return mem.datos[rowIdx];
}


// ── Escritura — log ───────────────────────────────────────────

/**
 * Agrega una entrada al log de operaciones STG_DOCENTES_LOG.
 * Columnas de sistema: sistema las llena completas.
 *
 * @param {object} entry
 * @param {string} entry.stageEntityType — "DOCENTE" | "ASIGNACION"
 * @param {string} entry.stageRecordId   — ID de la fila origen
 * @param {string} entry.action          — "VALIDATE" | "PROMOTE" | "INVITE" | "RETRY" | "CLEAN"
 * @param {string} entry.result          — "SUCCESS" | "ERROR" | "PARTIAL" | "SKIPPED"
 * @param {string} [entry.message]       — detalle del resultado
 * @param {string} [entry.loggedBy]      — email del ejecutor (default: usuario efectivo)
 */
function registrarStgDocentesLog(entry) {
  const mem      = getTableData("stagingDocentes", "STG_DOCENTES_LOG");
  const ahora    = nowSIDEP();
  const ejecutor = Session.getEffectiveUser().getEmail();
  const data     = entry || {};

  mem.datos.push([
    data.stageLogId       || uuid("stgdoc"),
    data.stageEntityType  || "DOCENTE",
    data.stageRecordId    || "",
    data.action           || "PROCESS",
    data.result           || "SUCCESS",
    data.message          || "",
    data.loggedAt         || ahora,
    data.loggedBy         || ejecutor
  ]);

  _escribirEnBatch_(mem.hoja, mem);
}
