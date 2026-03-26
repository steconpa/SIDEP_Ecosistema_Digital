/**
 * ============================================================
 * SIDEP — Diagnóstico Previo a Correcciones v1.0
 * Ejecutar ANTES de poblarConfiguraciones({force:true})
 * ============================================================
 *
 * PROPÓSITO:
 *   Verificar el estado del sistema sin modificar absolutamente nada.
 *   Confirmar que MR26/C1M2 está intacto antes de aplicar correcciones.
 *
 * CÓMO USAR:
 *   1. Copiar este código en cualquier archivo .gs del proyecto
 *   2. Ejecutar diagnosticoPrevioCorrecciones()
 *   3. Revisar el log — buscar líneas con ✅ / ⚠️ / ❌
 *   4. Solo ejecutar force si el log confirma estado seguro
 *
 * TIEMPO DE EJECUCIÓN: ~10 segundos (solo lectura)
 * CUOTAS: 4 llamadas Sheets API — completamente seguro
 * ============================================================
 */
function diagnosticoPrevioCorrecciones() {
  Logger.log("════════════════════════════════════════════════════════");
  Logger.log("🔍 SIDEP — Diagnóstico Previo a Correcciones v2.0");
  Logger.log("   Fecha: " + new Date().toLocaleString("es-CO", {timeZone:"America/Bogota"}));
  Logger.log("════════════════════════════════════════════════════════");

  try {
    var coreSS  = getSpreadsheetByName("core");
    var adminSS = getSpreadsheetByName("admin");

    // ──────────────────────────────────────────────────────────
    // CHECK 1: ¿Cuántos estados tiene _CFG_STATUSES?
    // ──────────────────────────────────────────────────────────
    Logger.log("\n📊 CHECK 1: _CFG_STATUSES (debe tener 48 filas de datos)");
    var hojaStatus = coreSS.getSheetByName("_CFG_STATUSES");
    if (!hojaStatus) {
      Logger.log("  ❌ Hoja _CFG_STATUSES no encontrada");
    } else {
      var countStatus = Math.max(0, hojaStatus.getLastRow() - 1); // -1 por encabezado
      if (countStatus === 48) {
        Logger.log("  ✅ _CFG_STATUSES: " + countStatus + " estados — CORRECTO (v2.0)");
        Logger.log("     14 tipos × promedio 3.4 estados = 48. El comentario 'v1.6 = 45' era incorrecto.");
      } else if (countStatus === 45) {
        Logger.log("  ⚠️  _CFG_STATUSES: " + countStatus + " estados — POSIBLE VERSIÓN ANTERIOR");
        Logger.log("     Falta verificar si faltan RECOGNITION_TYPE o STRUCTURE. Revisar manualmente.");
      } else if (countStatus < 45) {
        Logger.log("  ❌ _CFG_STATUSES: " + countStatus + " estados — INCOMPLETO");
        Logger.log("     Ejecutar poblarConfiguraciones({force:true}) para corregir.");
      } else {
        Logger.log("  ⚠️  _CFG_STATUSES: " + countStatus + " estados — VALOR INESPERADO");
        Logger.log("     Esperado: 48. Revisar manualmente.");
      }
    }

    // ──────────────────────────────────────────────────────────
    // CHECK 2: ¿Está GDR con el bloque ART correcto?
    // ──────────────────────────────────────────────────────────
    Logger.log("\n📊 CHECK 2: sbj_ADM_GDR bloque ART (debe ser A2B3, no A2B2)");
    var hojaSubj = coreSS.getSheetByName("_CFG_SUBJECTS");
    if (!hojaSubj) {
      Logger.log("  ❌ Hoja _CFG_SUBJECTS no encontrada");
    } else {
      var dataSubj = hojaSubj.getDataRange().getValues();
      var hSubj    = dataSubj[0];
      var iSubjId  = hSubj.indexOf("SubjectID");
      var iArtS    = hSubj.indexOf("ArtStartBlock");
      var gdrFila  = null;
      for (var r = 1; r < dataSubj.length; r++) {
        if (String(dataSubj[r][iSubjId]) === "sbj_ADM_GDR") {
          gdrFila = dataSubj[r];
          break;
        }
      }
      if (!gdrFila) {
        Logger.log("  ⚠️  sbj_ADM_GDR no encontrado en _CFG_SUBJECTS");
        Logger.log("     Puede que _CFG_SUBJECTS no esté poblada aún.");
      } else {
        var bloqueActual = String(gdrFila[iArtS] || "");
        if (bloqueActual === "A2B3") {
          Logger.log("  ✅ sbj_ADM_GDR.ArtStartBlock = A2B3 — CORRECTO");
          Logger.log("     El fix ya está aplicado. NO necesitas force solo por esto.");
        } else if (bloqueActual === "A2B2") {
          Logger.log("  ⚠️  sbj_ADM_GDR.ArtStartBlock = A2B2 — INCORRECTO");
          Logger.log("     Debe ser A2B3. Requiere poblarConfiguraciones({force:true}).");
        } else {
          Logger.log("  ⚠️  sbj_ADM_GDR.ArtStartBlock = '" + bloqueActual + "' — INESPERADO");
        }
      }
    }

    // ──────────────────────────────────────────────────────────
    // CHECK 3: ¿Los deployments MR26/C1M2 están CREADOS?
    //          (confirmar que no tocamos nada que está en CREATED)
    // ──────────────────────────────────────────────────────────
    Logger.log("\n📊 CHECK 3: MasterDeployments MR26/C1M2 — estado de aulas");
    // MasterDeployments está en SIDEP_01_CORE_ACADEMICO (coreSS), no en adminSS
    var hojaDepl = coreSS.getSheetByName("MasterDeployments");
    if (!hojaDepl) {
      Logger.log("  ❌ Hoja MasterDeployments no encontrada");
    } else {
      var dataDepl  = hojaDepl.getDataRange().getValues();
      var hDepl     = dataDepl[0];
      var iNom      = hDepl.indexOf("GeneratedNomenclature");
      var iStatus   = hDepl.indexOf("ScriptStatusCode");
      var mr26C1M2  = [];
      var otrosCohortes = {};
      for (var d = 1; d < dataDepl.length; d++) {
        var nom = String(dataDepl[d][iNom] || "");
        var st  = String(dataDepl[d][iStatus] || "");
        if (nom.indexOf("MR26") !== -1 && nom.indexOf("C1M2") !== -1) {
          mr26C1M2.push({ nom: nom, status: st });
        } else if (nom) {
          var coh = nom.split("-")[2] || "?";
          otrosCohortes[coh] = (otrosCohortes[coh] || 0) + 1;
        }
      }

      Logger.log("  MR26/C1M2 — " + mr26C1M2.length + " deployments:");
      var todosCreated = true;
      mr26C1M2.forEach(function(dep) {
        var icon = dep.status === "CREATED" ? "✅" : "⚠️ ";
        Logger.log("    " + icon + " " + dep.nom + " → " + dep.status);
        if (dep.status !== "CREATED") todosCreated = false;
      });

      if (todosCreated && mr26C1M2.length > 0) {
        Logger.log("  ✅ Todos los deployments MR26/C1M2 están CREATED — producción intacta");
      } else if (mr26C1M2.length === 0) {
        Logger.log("  ⚠️  No se encontraron deployments MR26/C1M2");
      }

      if (Object.keys(otrosCohortes).length > 0) {
        Logger.log("  Otros cohortes en MasterDeployments:");
        Object.keys(otrosCohortes).sort().forEach(function(c) {
          Logger.log("    " + c + ": " + otrosCohortes[c] + " deployments");
        });
      }
    }

    // ──────────────────────────────────────────────────────────
    // CHECK 4: ¿Cuántos estudiantes y matrículas hay cargados?
    // ──────────────────────────────────────────────────────────
    Logger.log("\n📊 CHECK 4: Students y Enrollments — conteo de seguridad");
    var hojaStud = adminSS.getSheetByName("Students");
    var hojaEnr  = adminSS.getSheetByName("Enrollments");
    var countStud = hojaStud ? Math.max(0, hojaStud.getLastRow() - 1) : 0;
    var countEnr  = hojaEnr  ? Math.max(0, hojaEnr.getLastRow()  - 1) : 0;
    Logger.log("  Students:   " + countStud + " registros");
    Logger.log("  Enrollments: " + countEnr + " matrículas");
    Logger.log("  NOTA: poblarConfiguraciones({force:true}) NO toca estas tablas.");
    Logger.log("        Solo limpia _CFG_* — Students/Enrollments siempre están seguros.");

    // ──────────────────────────────────────────────────────────
    // RESUMEN — DECISIÓN
    // ──────────────────────────────────────────────────────────
    Logger.log("\n════════════════════════════════════════════════════════");
    Logger.log("📋 RESUMEN — ¿Qué ejecutar?");
    Logger.log("════════════════════════════════════════════════════════");
    Logger.log("");
    Logger.log("  1. Si CHECK 1 mostró < 45 estados:");
    Logger.log("     → Actualiza 02_poblarConfiguraciones.gs (v1.7 del patch)");
    Logger.log("     → Ejecuta: poblarConfiguraciones({force:true})");
    Logger.log("     → Esto también aplica el fix del bloque ADM-GDR.");
    Logger.log("");
    Logger.log("  2. Si CHECK 1 ya mostró 45 estados pero CHECK 2 mostró A2B2:");
    Logger.log("     → Actualiza solo la línea de GDR en 02_poblarConfiguraciones.gs");
    Logger.log("     → Ejecuta: poblarConfiguraciones({force:true})");
    Logger.log("     → Tarda ~30 segundos. MR26/C1M2 sigue intacto.");
    Logger.log("");
    Logger.log("  3. 07_importarEstudiantes.gs (TRV_SUBJECTS):");
    Logger.log("     → Actualiza el archivo con la versión 1.1.1 del patch");
    Logger.log("     → NO ejecutar importarEstudiantes() — solo actualizar el código");
    Logger.log("     → El fix aplica en la próxima importación (siguiente cohorte)");
    Logger.log("");
    Logger.log("  ✅ Students, Enrollments y MasterDeployments NO se modifican");
    Logger.log("     en ninguno de los pasos anteriores.");
    Logger.log("════════════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("\n❌ ERROR en diagnóstico: " + e.message);
    Logger.log("   Stack: " + (e.stack || "no disponible"));
  }
}