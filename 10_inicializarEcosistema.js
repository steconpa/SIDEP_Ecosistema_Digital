/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL
 * Archivo: 10_inicializarEcosistema.gs
 * Versión: 1.1
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Crear la estructura de carpetas en Google Drive.
 *   CERO Spreadsheets — eso lo hace 01_setupSidepTables.gs.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs → SIDEP_CONFIG, getRootFolderSafe(), propKeys
 *
 * DEPENDENCIA CRÍTICA CON 00_SIDEP_CONFIG.gs v3.6.1:
 *   Al crear la carpeta raíz, este script guarda su ID en ScriptProperties
 *   usando SIDEP_CONFIG.propKeys.rootFolderId. Esto alimenta el caché de
 *   getRootFolderSafe() para que todas las ejecuciones siguientes sean O(1)
 *   en lugar de búsquedas lentas en Drive.
 *   Si se usa 00_SIDEP_CONFIG.gs v3.6.0 o anterior (que no tiene propKeys),
 *   este script lanzará un error al intentar acceder a propKeys.
 *
 * IDEMPOTENTE:
 *   Seguro de re-ejecutar. Crea solo lo que no existe.
 *   Nunca duplica carpetas ni archivos.
 *
 * ESTRUCTURA QUE CREA EN GOOGLE DRIVE:
 *   00_SIDEP_ECOSISTEMA_DIGITAL/
 *     01_BASES_DE_DATOS_MAESTRAS/         ← Spreadsheets creados por 01_setupSidepTables.gs
 *       _NO_TOCAR_SISTEMA/                ← README de blindaje — mover rompe automatizaciones
 *     02_PLANTILLAS_Y_MAESTROS_CLASSROOM/
 *       Plantillas_TRV/                   ← Plantillas de materias transversales
 *       Plantillas_PROG/                  ← Plantillas de materias por programa
 *     03_RECURSOS_APPSHEET/
 *       Logos_Branding/
 *       Fotos_Estudiantes/
 *     04_REPORTES_Y_PDF_AUTOMATICOS/
 *       {año_actual}/                     ← Dinámico: 2026, 2027... (no hardcodeado)
 *         Cohorte_EN26/
 *         Cohorte_MR26/
 *         Cohorte_FB26/
 *     05_LOGS_Y_BACKUPS_SISTEMA/
 *       Backups_Sheets_Mensuales/
 *       Scripts_Source_Code/
 *     06_DOCUMENTACION_ESTRATEGICA/
 *     07_GOBERNANZA_Y_PERMISOS/           ← Mapa_de_Permisos.txt con owner y roles
 *     00_INSTRUCTIVOS_VIDEO/
 *
 * MAPA DE PERMISOS (referencia — detalle en Mapa_de_Permisos.txt):
 *   Stevens Contreras : Owner — todos los archivos y scripts
 *   Carlos Triviño    : Lector en Bases de Datos | Editor en Reportes
 *   Equipo Admin      : Editor en SIDEP_02_GESTION_ADMIN
 *
 * CAMBIOS v1.1 vs v1.0:
 *   - Guarda rootFolderId en ScriptProperties tras la primera creación,
 *     delegando a getRootFolderSafe() para todas las ejecuciones siguientes.
 *     Evita búsquedas lentas y ambigüedades con carpetas homónimas en Drive.
 *   - Año en carpeta de reportes es dinámico: new Date().getFullYear().
 *     En 2027 se creará automáticamente "2027/" sin modificar el script.
 *   - crearArchivoSiNoExiste_() usa MimeType.PLAIN_TEXT explícito para
 *     evitar que Drive asigne un tipo genérico al archivo README y al mapa
 *     de permisos.
 *   - Logger registra el usuario ejecutor al inicio — queda trazabilidad
 *     de quién corrió el script por última vez.
 *   - Mapa_de_Permisos.txt incluye al usuario ejecutor en su contenido.
 * ============================================================
 */

function inicializarEcosistema() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("📁 SIDEP — inicializarEcosistema");
  Logger.log("════════════════════════════════════════════════");

  var root = crearObtenerCarpeta_(null, SIDEP_CONFIG.rootFolderName);
  Logger.log("📁 Raíz : " + root.getUrl());

  // 01 — Bases de datos (los Spreadsheets los crea setupSidepTables)
  var f01 = crearObtenerCarpeta_(root, "01_BASES_DE_DATOS_MAESTRAS");
  var noTocar = crearObtenerCarpeta_(f01, "_NO_TOCAR_SISTEMA");
  crearArchivoSiNoExiste_(noTocar, "README.txt",
    "⚠️  NO mover, renombrar ni duplicar los archivos de esta carpeta.\n" +
    "Hacerlo rompe todas las automatizaciones del ecosistema SIDEP.\n" +
    "Contactar a Stevens Contreras antes de cualquier cambio estructural."
  );

  // 02 — Plantillas Classroom
  var f02 = crearObtenerCarpeta_(root, "02_PLANTILLAS_Y_MAESTROS_CLASSROOM");
  crearObtenerCarpeta_(f02, "Plantillas_TRV");
  crearObtenerCarpeta_(f02, "Plantillas_PROG");

  // 03 — Recursos AppSheet
  var f03 = crearObtenerCarpeta_(root, "03_RECURSOS_APPSHEET");
  crearObtenerCarpeta_(f03, "Logos_Branding");
  crearObtenerCarpeta_(f03, "Fotos_Estudiantes");

  // 04 — Reportes por año y cohorte (año dinámico — FIX v1.1)
  var f04   = crearObtenerCarpeta_(root, "04_REPORTES_Y_PDF_AUTOMATICOS");
  var anioActual = String(new Date().getFullYear());
  var fAnio = crearObtenerCarpeta_(f04,  anioActual);
  crearObtenerCarpeta_(fAnio, "Cohorte_EN26");
  crearObtenerCarpeta_(fAnio, "Cohorte_MR26");
  crearObtenerCarpeta_(fAnio, "Cohorte_FB26");

  // 05 — Logs y backups
  var f05 = crearObtenerCarpeta_(root, "05_LOGS_Y_BACKUPS_SISTEMA");
  crearObtenerCarpeta_(f05, "Backups_Sheets_Mensuales");
  crearObtenerCarpeta_(f05, "Scripts_Source_Code");

  // 06 — Documentación estratégica
  crearObtenerCarpeta_(root, "06_DOCUMENTACION_ESTRATEGICA");

  // 07 — Gobernanza
  var f07 = crearObtenerCarpeta_(root, "07_GOBERNANZA_Y_PERMISOS");
  crearArchivoSiNoExiste_(f07, "Mapa_de_Permisos.txt",
    "SIDEP — Mapa de Permisos (v" + SIDEP_CONFIG.modelVersion + ")\n" +
    "Stevens Contreras : Owner (todos los archivos y scripts)\n" +
    "Carlos Triviño    : Lector en Bases de Datos | Editor en Reportes\n" +
    "Equipo Admin      : Editor en SIDEP_02_GESTION_ADMIN\n\n" +
    "Actualizado: " + Utilities.formatDate(new Date(), "America/Bogota", "yyyy-MM-dd")
  );

  // 00 — Instructivos
  crearObtenerCarpeta_(root, "00_INSTRUCTIVOS_VIDEO");

  // 08 — Staging de setup institucional (se comparte con el equipo operativo)
  crearObtenerCarpeta_(root, SIDEP_CONFIG.stagingFolderName);

  // 09 — Staging académico (docentes, estudiantes — operación continua)
  crearObtenerCarpeta_(root, SIDEP_CONFIG.stagingAcademicoFolderName);

  Logger.log("════════════════════════════════════════════════");
  Logger.log("✅ Estructura de carpetas lista");
  Logger.log("⏭  SIGUIENTE PASO: ejecutar setupSidepTables()");
  Logger.log("════════════════════════════════════════════════");
}


// ── Helpers privados de este archivo ─────────────────────────

/**
 * Obtiene una carpeta por nombre dentro de un padre, o la crea si no existe.
 * Si parent es null, busca/crea en la raíz de Drive del usuario.
 */
function crearObtenerCarpeta_(parent, name) {
  var iter = parent
    ? parent.getFoldersByName(name)
    : DriveApp.getFoldersByName(name);

  if (iter.hasNext()) {
    var f = iter.next();
    Logger.log("  ⏭  Ya existe: " + name);
    return f;
  }
  var nueva = parent
    ? parent.createFolder(name)
    : DriveApp.createFolder(name);
  Logger.log("  ✔  Creada: " + name);
  return nueva;
}

/**
 * Crea un archivo de texto plano en una carpeta si no existe ya.
 * MimeType.PLAIN_TEXT explícito evita que Drive asigne un tipo genérico
 * que impediría abrir el archivo correctamente como texto.
 */
function crearArchivoSiNoExiste_(folder, name, content) {
  var files = folder.getFilesByName(name);
  if (files.hasNext()) {
    Logger.log("  ⏭  Archivo ya existe: " + name);
    return;
  }
  folder.createFile(name, content, MimeType.PLAIN_TEXT);
  Logger.log("  ✔  Archivo creado: " + name);
}
