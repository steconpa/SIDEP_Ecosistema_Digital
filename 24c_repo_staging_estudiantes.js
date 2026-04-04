/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 24c_repo_staging_estudiantes.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Acceso a datos del spreadsheet SIDEP_STG_ESTUDIANTES.
 *   CERO reglas de negocio — solo lectura y escritura en batch.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs  → SIDEP_CONFIG.files.stagingEstudiantes
 *   02_SIDEP_HELPERS.gs → getTableData(), _leerHoja_(), _escribirEnBatch_()
 *   04_SIDEP_STAGING_TABLES.gs → STAGING_ESTUDIANTES_TABLES
 *
 * TABLAS:
 *   STG_ESTUDIANTES    → una fila por estudiante a registrar / actualizar
 *   STG_MATRICULAS     → una fila por matrícula estudiante × aula
 *   STG_ESTUDIANTES_LOG → auditoría de cada operación (escritura exclusiva del sistema)
 * ============================================================
 */


// ── Lectura ──────────────────────────────────────────────────

/**
 * Lee STG_ESTUDIANTES, opcionalmente filtrando por StageStatus.
 *
 * @param {object} [options]
 * @param {string} [options.stageStatus] — si se pasa, filtra filas con ese estado
 * @returns {{ ss, hoja, encabezado, idx, datos }}
 */
function leerStgEstudiantes(options) {
  var opts   = options || {};
  var filter = opts.stageStatus || null;
  var mem    = getTableData("stagingEstudiantes", "STG_ESTUDIANTES");

  if (filter) {
    mem.datos = mem.datos.filter(function(row) {
      return String(row[mem.idx["StageStatus"]] || "").trim() === filter;
    });
  }

  return mem;
}


/**
 * Lee STG_MATRICULAS, opcionalmente filtrando por StageStatus.
 *
 * @param {object} [options]
 * @param {string} [options.stageStatus]
 * @returns {{ ss, hoja, encabezado, idx, datos }}
 */
function leerStgMatriculas(options) {
  var opts   = options || {};
  var filter = opts.stageStatus || null;
  var mem    = getTableData("stagingEstudiantes", "STG_MATRICULAS");

  if (filter) {
    mem.datos = mem.datos.filter(function(row) {
      return String(row[mem.idx["StageStatus"]] || "").trim() === filter;
    });
  }

  return mem;
}


// ── Escritura — actualización de fila individual ─────────────

/**
 * Actualiza columnas de una fila en STG_ESTUDIANTES por StageEstudianteID.
 *
 * @param {string} stageEstudianteId
 * @param {object} patch — { ColName: value, ... }
 */
function actualizarStgEstudiante(stageEstudianteId, patch) {
  var mem = getTableData("stagingEstudiantes", "STG_ESTUDIANTES");
  var iId = mem.idx["StageEstudianteID"];
  var id  = String(stageEstudianteId || "").trim();

  if (!id) throw new Error("actualizarStgEstudiante: StageEstudianteID es obligatorio.");

  var rowIdx = mem.datos.findIndex(function(row) {
    return String(row[iId] || "").trim() === id;
  });

  if (rowIdx === -1) {
    throw new Error("actualizarStgEstudiante: StageEstudianteID no encontrado -> " + id);
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
 * Actualiza columnas de una fila en STG_MATRICULAS por StageMatriculaID.
 *
 * @param {string} stageMatriculaId
 * @param {object} patch — { ColName: value, ... }
 */
function actualizarStgMatricula(stageMatriculaId, patch) {
  var mem = getTableData("stagingEstudiantes", "STG_MATRICULAS");
  var iId = mem.idx["StageMatriculaID"];
  var id  = String(stageMatriculaId || "").trim();

  if (!id) throw new Error("actualizarStgMatricula: StageMatriculaID es obligatorio.");

  var rowIdx = mem.datos.findIndex(function(row) {
    return String(row[iId] || "").trim() === id;
  });

  if (rowIdx === -1) {
    throw new Error("actualizarStgMatricula: StageMatriculaID no encontrado -> " + id);
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
 * Agrega una entrada al log de operaciones STG_ESTUDIANTES_LOG.
 *
 * @param {object} entry
 * @param {string} entry.stageEntityType — "ESTUDIANTE" | "MATRICULA"
 * @param {string} entry.stageRecordId   — ID de la fila origen
 * @param {string} entry.action          — "VALIDATE" | "PROMOTE" | "NOTIFY"
 * @param {string} entry.result          — "SUCCESS" | "ERROR" | "PARTIAL" | "SKIPPED"
 * @param {string} [entry.message]
 * @param {string} [entry.loggedBy]
 */
function registrarStgEstudiantesLog(entry) {
  var mem      = getTableData("stagingEstudiantes", "STG_ESTUDIANTES_LOG");
  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();
  var data     = entry || {};

  mem.datos.push([
    data.stageLogId       || uuid("stgest"),
    data.stageEntityType  || "ESTUDIANTE",
    data.stageRecordId    || "",
    data.action           || "PROCESS",
    data.result           || "SUCCESS",
    data.message          || "",
    data.loggedAt         || ahora,
    data.loggedBy         || ejecutor
  ]);

  _escribirEnBatch_(mem.hoja, mem);
}
