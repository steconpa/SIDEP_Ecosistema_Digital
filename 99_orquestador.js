/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL
 * Archivo: 99_orquestador.gs
 * Versión: 2.3
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Capa UX sobre el pipeline. CERO lógica de negocio propia.
 *   Cada función delega directamente al script correspondiente.
 *   Punto de entrada para ejecutar desde el editor sin recordar
 *   nombres de función ni argumentos de cada script.
 *
 * DEPENDE DE:
 *   10_inicializarEcosistema.gs  → inicializarEcosistema()
 *   11_setupSidepTables.gs       → setupSidepTables()
 *   12_poblarConfiguraciones.gs  → poblarConfiguraciones()
 *   12b_poblarAperturas.gs       → poblarAperturas(), gestionarApertura(),
 *                                   diagnosticoAperturas()
 *   12c_operacionesCatalogos.gs  → aplicarTiposPostBootstrap(), repoblarTabla()
 *   13_poblarSyllabus.gs         → poblarSyllabus()
 *   14_crearAulas.gs             → planificarDesdeAperturaPlan(), planificarYCrear(),
 *                                   crearAulas(), diagnosticoAulas(),
 *                                   planificarDeployments() [@deprecated]
 *   15_estructurarAulas.gs       → estructurarAulas(), diagnosticoEstructura()
 *   16_importarDocentes.gs       → importarDocentes()
 *   16b_sincronizarDocentes.gs   → sincronizarInvitaciones(), diagnosticoInvitaciones(),
 *                                   configurarTriggerDiario(), eliminarTriggerDiario()
 *   17_importarEstudiantes.gs    → importarEstudiantes(), diagnosticoEstudiantes()
 *   18_notificarEstudiantes.gs   → notificarEstudiantes(), notificarEstudiantes_dryRun(),
 *                                   notificarEstudiante_individual(), diagnosticoNotificaciones()
 *   00_SIDEP_CONFIG.gs v4.2.0+   → SIDEP_CONFIG, nowSIDEP()
 *
 * FUNCIONES DISPONIBLES (ejecutar directamente desde el editor GAS):
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │  ONBOARDING COMPLETO (primera vez)                  │
 *   │  → onboardingCompleto()  pasos 0–3 en secuencia     │
 *   │    00b → 01 → 02 → 03  (04+ requieren confirmación) │
 *   ├─────────────────────────────────────────────────────┤
 *   │  PASOS INDIVIDUALES (re-ejecuciones, actualizaciones)│
 *   │  → paso0_carpetas()           carpetas Drive        │
 *   │  → paso1_tablas()             estructura hojas      │
 *   │  → paso1_tablas_force()       recrear desde cero    │
 *   │  → paso2_configuraciones()    catálogos _CFG_*      │
 *   │  → paso2_configuraciones_force()                    │
 *   │  → paso3_syllabus()           temarios              │
 *   │  → paso3_syllabus_force()                           │
 *   ├─────────────────────────────────────────────────────┤
 *   │  PASO 2b — APERTURAS (antes de cada nuevo período)  │
 *   │  → paso2b_aperturas(cohort)   registra plan base    │
 *   │  → paso2b_aperturas_force(cohort) reescribe         │
 *   │  → paso2b_diagnostico()       estado APERTURA_PLAN  │
 *   │  Atajos base: _MR26, _EN26, _MY26, _AG26, _SP26     │
 *   │  Cambios por período:                               │
 *   │  → paso2b_cambios_MR26_C1M2() 7 cambios Carlos MR26  │
 *   ├─────────────────────────────────────────────────────┤
 *   │  PASO 4 — AULAS CLASSROOM (por ventana/cohort)      │
 *   │  PREREQUISITO: paso2b ejecutado primero             │
 *   │  → paso4_dryRun(cohort, moment)  preview            │
 *   │  → paso4_planificar(cohort, moment)  genera PENDING │
 *   │  → paso4_planificarYCrear(cohort, moment)  completo │
 *   │  → paso4_crearAulas(cohort)      procesa PENDING    │
 *   │  → paso4_diagnostico()           estado actual      │
 *   │  Atajos por ventana 2026: _EN26_C1M1, _MR26_C1M2…  │
 *   ├─────────────────────────────────────────────────────┤
 *   │  PASO 5 — ESTRUCTURA CLASSROOM (topics por semana)  │
 *   │  → paso5_estructurar(cohort)     crea topics        │
 *   │  → paso5_diagnostico()           estado actual      │
 *   ├─────────────────────────────────────────────────────┤
 *   │  PASO 6 — IMPORTAR DOCENTES                         │
 *   │  → paso6_importarDocentes()      envía invitaciones │
 *   │  → paso6_diagnosticoInvitaciones() estado actual    │
 *   ├─────────────────────────────────────────────────────┤
 *   │  PASO 6b — SINCRONIZAR INVITACIONES (automático)    │
 *   │  → paso6b_sincronizar()          verifica y actualiza│
 *   │  → paso6b_sincronizarDryRun()    preview sin cambios│
 *   │  → paso6b_instalarTrigger()      trigger diario 7AM │
 *   │  → paso6b_eliminarTrigger()      desinstalar trigger │
 *   ├─────────────────────────────────────────────────────┤
 *   │  PASO 7 — IMPORTAR ESTUDIANTES                      │
 *   │  PREREQUISITO: ESTUDIANTES_DATA lista en 17_...gs   │
 *   │  → paso7_importarEstudiantes()   invita + matricula │
 *   │  → paso7_diagnostico()           estado actual      │
 *   ├─────────────────────────────────────────────────────┤
 *   │  PASO 8 — NOTIFICAR ESTUDIANTES (links de acceso)   │
 *   │  → paso8_dryRun()     preview emails en Logger      │
 *   │  → paso8_notificar()  envía emails con join links   │
 *   │  → paso8_reenviar(email) reenvío individual         │
 *   ├─────────────────────────────────────────────────────┤
 *   │  DIAGNÓSTICO GENERAL                                │
 *   │  → diagnosticoSistema()  estado completo del SS     │
 *   └─────────────────────────────────────────────────────┘
 *
 * PRINCIPIO DE IDEMPOTENCIA:
 *   Cada paso es seguro de re-ejecutar. En modo SAFE (default)
 *   nunca duplica carpetas, Spreadsheets ni registros.
 *   Los modos FORCE reescriben — usarlos con intención explícita.
 *
 * BUG CONOCIDO — onboardingCompleto() y parada ante error crítico:
 *   forEach() no soporta break nativo en JS. El flag `detenido`
 *   implementa la parada: si i < 2 (pasos 0 y 1 son críticos),
 *   se activa y los pasos siguientes se saltan explícitamente.
 *   Pasos 2+ son recuperables individualmente; no detienen el loop.
 *
 * PARA AGREGAR UN NUEVO PASO AL PIPELINE:
 *   1. Crear las funciones wrapper paso{N}_* en este archivo.
 *   2. Agregar la entrada en el array `pasos` de onboardingCompleto()
 *      solo si el paso es seguro sin opciones (muchos requieren cohortCode).
 *   3. Actualizar el bloque ASCII de FUNCIONES DISPONIBLES arriba.
 *
 * CAMBIOS v2.3 vs v2.2:
 *   - NUEVO: sección PASO 6 — importar docentes (wrapper de importarDocentes()).
 *   - NUEVO: sección PASO 6b — sincronizar invitaciones desde Classroom.
 *     paso6b_sincronizar(): verifica qué invitaciones fueron aceptadas/rechazadas.
 *     paso6b_instalarTrigger(): activa verificación automática diaria a las 7AM.
 *     paso6b_eliminarTrigger(): desactiva el trigger cuando ya no haya pendientes.
 *   - Actualizado DEPENDE DE: refleja 06_importarDocentes.gs y nuevo 06b.
 *   - Referencia a CONFIG v4.1.0+.
 *
 * CAMBIOS v2.2 vs v2.1:
 *   - NUEVO: sección PASO 2b — gestión de APERTURA_PLAN antes de cada período.
 *     paso2b_aperturas(cohort): registra el plan base desde obtenerPlanDeAperturas_().
 *     paso2b_aperturas_force(cohort): reescribe el plan del cohorte indicado.
 *     paso2b_diagnostico(): muestra estado de APERTURA_PLAN por cohorte/momento.
 *     Atajos por cohorte: paso2b_aperturas_MR26(), _EN26, _MY26, _AG26, _SP26.
 *   - NUEVO: funciones paso2b_cambios_{COHORT}_{MOMENT}() — cambios confirmados
 *     por Carlos para cada período. Permanentes en el flujo. Documentan cada
 *     desviación de la malla oficial con trazabilidad (via gestionarApertura()).
 *     Primera implementación: paso2b_cambios_MR26_C1M2() con CRC→SEM y MDA nueva.
 *   - NUEVO: flujo completo por período en PATRÓN DE USO del PASO 4 ahora
 *     referencia explícitamente paso2b como prerequisito.
 *   - Actualizado FUNCIONES DISPONIBLES: refleja sección PASO 2b completa.
 *
 * CAMBIOS v2.1 vs v2.0:
 *   - paso4_dryRun() y paso4_planificar() migrados de planificarDeployments()
 *     @deprecated a planificarDesdeAperturaPlan() — función principal v4.0.0.
 *     Ahora ambas funciones leen APERTURA_PLAN en lugar de filtrar _CFG_SUBJECTS
 *     por DirStartMoment. paso4_planificar() también actualiza APERTURA_PLAN
 *     (AperturaStatus PENDIENTE → CREADA) como parte del flujo.
 *   - Actualizado DEPENDE DE: refleja 12b_poblarAperturas.gs y renombramiento
 *     de funciones en 04_crearAulas.gs.
 *   - Actualizado PATRÓN DE USO en comentario de PASO 4: incluye poblarAperturas()
 *     como prerequisito antes del dryRun.
 *   - Referencia a CONFIG v4.0.1+.
 *
 * CAMBIOS v2.0 vs v1.0:
 *   - Versión explícita (antes no tenía número de versión).
 *   - BUG FIX: onboardingCompleto() usaba return dentro de forEach
 *     para detener ante error crítico — return solo sale de la iteración.
 *     Corregido con flag `detenido` que salta explícitamente el resto.
 *   - BUG FIX: paso4_planificar_EN26() llamaba planificarDeployments()
 *     sin momentCode ni confirmarTodos:true → quedaba bloqueado.
 *     Corregido con confirmarTodos:true explícito.
 *   - diagnosticoSistema() usa getRootFolderSafe() con cache de
 *     ScriptProperties en lugar de DriveApp.getFoldersByName() directo.
 *   - Wrappers paso4_* generalizados con funciones parametrizadas
 *     para todas las ventanas 2026 (antes solo había atajos EN26).
 *   - Agregados wrappers paso5_* para 05_estructurarAulas.gs.
 *   - nowSIDEP() en timestamps del Logger.
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// ONBOARDING COMPLETO — ejecutar SOLO la primera vez
// ─────────────────────────────────────────────────────────────

/**
 * Inicializa el ecosistema SIDEP completo desde cero.
 * Ejecuta los pasos 0–3 en orden. El paso 4 (Classroom) requiere
 * confirmación de docentes con Carlos y se ejecuta por separado
 * con cohortCode explícito vía paso4_planificarYCrear().
 *
 * Tiempo estimado: 60–120 segundos en primera ejecución.
 *
 * MANEJO DE ERRORES:
 *   Si falla un paso crítico (i < 2: carpetas o tablas), se activa
 *   el flag `detenido` y los pasos siguientes se saltan.
 *   Los pasos 2+ son recuperables individualmente sin re-ejecutar todo.
 */
function onboardingCompleto() {
  var t0 = Date.now();

  Logger.log("╔══════════════════════════════════════════════════╗");
  Logger.log("║  SIDEP — ONBOARDING COMPLETO                     ║");
  Logger.log("║  v" + SIDEP_CONFIG.modelVersion + " | " + Utilities.formatDate(nowSIDEP(), "America/Bogota", "yyyy-MM-dd HH:mm") + "               ║");
  Logger.log("╚══════════════════════════════════════════════════╝");

  var pasos = [
    { nombre: "PASO 0 — Carpetas Drive",       fn: inicializarEcosistema  },
    { nombre: "PASO 1 — Estructura de tablas", fn: setupSidepTables       },
    { nombre: "PASO 2 — Catálogos _CFG_*",     fn: poblarConfiguraciones  },
    { nombre: "PASO 3 — Syllabus pedagógico",  fn: poblarSyllabus         },
    // PASO 4 requiere cohortCode explícito y confirmación de Carlos.
    // Ejecutar vía paso4_planificarYCrear() cuando esté listo.
    // PASO 5 requiere que PASO 4 haya creado aulas (CREATED en MasterDeployments).
  ];

  var errores   = [];
  var detenido  = false; // flag para simular break dentro de forEach

  pasos.forEach(function(paso, i) {
    // Si un paso crítico (0 o 1) falló antes, saltar los siguientes
    if (detenido) {
      Logger.log("\n⏭  " + paso.nombre + " — SALTADO (paso crítico anterior falló)");
      return;
    }

    Logger.log("\n┌─ " + paso.nombre + " " + "─".repeat(Math.max(0, 44 - paso.nombre.length)));
    try {
      paso.fn();
      Logger.log("└─ ✅ Completado");
    } catch (e) {
      Logger.log("└─ ❌ FALLÓ: " + e.message);
      errores.push({ paso: paso.nombre, error: e.message });
      // Pasos 0 y 1 son prerequisitos duros — sin ellos nada puede continuar
      if (i < 2) {
        Logger.log("\n⛔ Deteniendo onboarding — los pasos siguientes dependen de este.");
        detenido = true;
      }
    }
  });

  var dur = ((Date.now() - t0) / 1000).toFixed(1);

  Logger.log("\n╔══════════════════════════════════════════════════╗");
  if (errores.length === 0) {
    Logger.log("║  ✅ ONBOARDING COMPLETO EN " + dur + "s" + " ".repeat(Math.max(0, 22 - dur.length)) + "║");
    Logger.log("╠══════════════════════════════════════════════════╣");
    Logger.log("║  VERIFICAR EN DRIVE:                             ║");
    Logger.log("║  Drive → " + SIDEP_CONFIG.rootFolderName.substring(0, 38) + "  ║");
    Logger.log("╠══════════════════════════════════════════════════╣");
    Logger.log("║  PRÓXIMOS PASOS:                                 ║");
    Logger.log("║  1. Carlos confirma docentes y horarios          ║");
    Logger.log("║  2. paso4_planificarYCrear_EN26_C1M1()           ║");
    Logger.log("║  3. paso5_estructurar_EN26()                     ║");
    Logger.log("╚══════════════════════════════════════════════════╝");
  } else {
    Logger.log("║  ⚠️  ONBOARDING CON " + errores.length + " ERROR(ES) — " + dur + "s" + " ".repeat(Math.max(0, 14 - dur.length)) + "║");
    Logger.log("╠══════════════════════════════════════════════════╣");
    errores.forEach(function(e) {
      Logger.log("║  ❌ " + e.paso.substring(0, 44) + "  ║");
      Logger.log("║     " + e.error.substring(0, 44) + "  ║");
    });
    Logger.log("╠══════════════════════════════════════════════════╣");
    Logger.log("║  → Revisar el log completo arriba para detalles  ║");
    Logger.log("║  → Corregir y ejecutar el paso individual        ║");
    Logger.log("╚══════════════════════════════════════════════════╝");
  }
}


// ─────────────────────────────────────────────────────────────
// PASOS INDIVIDUALES — para actualizaciones y re-ejecuciones
// ─────────────────────────────────────────────────────────────

/** Crea o verifica la estructura de carpetas en Google Drive. */
function paso0_carpetas() {
  Logger.log("▶ Ejecutando PASO 0: Carpetas Drive...");
  inicializarEcosistema();
}

/**
 * Crea o actualiza la estructura de hojas en los 3 Spreadsheets.
 * Preserva datos existentes en modo SAFE.
 * Usar { force: true } para recrear desde cero.
 */
function paso1_tablas() {
  Logger.log("▶ Ejecutando PASO 1: Estructura de tablas...");
  setupSidepTables();
}
function paso1_tablas_force() {
  Logger.log("▶ Ejecutando PASO 1 FORCE: Recrear todas las tablas...");
  Logger.log("⚠️  ADVERTENCIA: Esto eliminará todos los datos existentes.");
  setupSidepTables({ force: true });
}

/**
 * Pobla los catálogos _CFG_* con los datos base del sistema.
 * Preserva datos existentes en modo SAFE.
 */
function paso2_configuraciones() {
  Logger.log("▶ Ejecutando PASO 2: Catálogos _CFG_*...");
  poblarConfiguraciones();
}
function paso2_configuraciones_force() {
  Logger.log("▶ Ejecutando PASO 2 FORCE: Reescribir catálogos...");
  poblarConfiguraciones({ force: true });
}

/**
 * Pobla _CFG_SYLLABUS con los temarios pedagógicos de las 57 materias.
 * Preserva datos existentes en modo SAFE.
 */
function paso3_syllabus() {
  Logger.log("▶ Ejecutando PASO 3: Syllabus pedagógico...");
  poblarSyllabus();
}
function paso3_syllabus_force() {
  Logger.log("▶ Ejecutando PASO 3 FORCE: Reescribir syllabus...");
  poblarSyllabus({ force: true });
}


// ─────────────────────────────────────────────────────────────
// PASO 2b — Aperturas por período
// ─────────────────────────────────────────────────────────────
//
// CUÁNDO EJECUTAR:
//   Al inicio de cada período, DESPUÉS de que Carlos confirme qué
//   asignaturas se dictan y ANTES de ejecutar el PASO 4 (Classroom).
//
// FLUJO COMPLETO POR PERÍODO (en orden):
//   1. paso2b_aperturas_{COHORT}()         → registra plan base de la malla
//   2. paso2b_cambios_{COHORT}_{MOMENT}()  → aplica cambios que Carlos confirmó
//   3. paso2b_diagnostico()                → verificar PENDIENTE / CANCELADA
//   4. paso4_dryRun(cohort, moment)        → preview sin tocar Classroom
//   5. paso4_planificarYCrear(cohort, moment) → ejecutar
//
// PARA CADA NUEVO PERÍODO:
//   1. Actualizar obtenerPlanDeAperturas_() en 12b_poblarAperturas.gs
//      con las materias que abre el nuevo cohorte.
//   2. Crear una función paso2b_cambios_{COHORT}_{MOMENT}() en este
//      archivo con los cambios que Carlos confirme para ese período.
//   3. Agregar el atajo de base abajo (paso2b_aperturas_{COHORT}).
// ─────────────────────────────────────────────────────────────

// ── Funciones genéricas (parametrizadas) ─────────────────────

/**
 * Registra el plan base de aperturas para el cohorte indicado.
 * Lee obtenerPlanDeAperturas_() en 12b_poblarAperturas.gs.
 * Modo SAFE: agrega sin duplicar. Re-ejecutar es seguro.
 * PREREQUISITO: setupSidepTables() y poblarConfiguraciones() ya ejecutados.
 *
 * @param {string} cohortCode — cohorte a registrar (MR26, EN26, MY26...)
 */
function paso2b_aperturas(cohortCode) {
  Logger.log("▶ PASO 2b: Registrando aperturas base para " + cohortCode + "...");
  poblarAperturas({ cohortCode: cohortCode });
}

/**
 * Reescribe el plan base del cohorte indicado desde cero.
 * Usar cuando obtenerPlanDeAperturas_() fue corregido y hay que
 * reemplazar lo que ya estaba en APERTURA_PLAN.
 * ⚠️  Borra y reescribe SOLO las filas del cohorte indicado.
 *
 * @param {string} cohortCode
 */
function paso2b_aperturas_force(cohortCode) {
  Logger.log("▶ PASO 2b FORCE: Reescribiendo aperturas de " + cohortCode + "...");
  poblarAperturas({ cohortCode: cohortCode, force: true });
}

/**
 * Muestra el estado actual de APERTURA_PLAN agrupado por cohorte y momento.
 * Incluye quién y cuándo se hizo cada cambio (UpdatedBy / UpdatedAt).
 * Solo lectura — no modifica nada.
 */
function paso2b_diagnostico() {
  diagnosticoAperturas();
}

// ── Atajos base por cohorte 2026 ─────────────────────────────
// Registran el plan base sin cambios. Ejecutar ANTES de los cambios de Carlos.

/** MR26 — ventana Marzo 2026. Abre C1M2. */
function paso2b_aperturas_MR26() { paso2b_aperturas("MR26"); }
function paso2b_aperturas_force_MR26() { paso2b_aperturas_force("MR26"); }

/** EN26 — ventana Enero 2026. Avanzando a C2M1 (confirmar con Carlos). */
function paso2b_aperturas_EN26() { paso2b_aperturas("EN26"); }
function paso2b_aperturas_force_EN26() { paso2b_aperturas_force("EN26"); }

/** MY26 — ventana Mayo 2026. Abre C2M1 (19-may-2026). */
function paso2b_aperturas_MY26() { paso2b_aperturas("MY26"); }
function paso2b_aperturas_force_MY26() { paso2b_aperturas_force("MY26"); }

/** AG26 — ventana Agosto 2026. Abre C2M2 (4-ago-2026). */
function paso2b_aperturas_AG26() { paso2b_aperturas("AG26"); }
function paso2b_aperturas_force_AG26() { paso2b_aperturas_force("AG26"); }

/** SP26 — ventana Septiembre 2026. Abre C1M1 (29-sep-2026). */
function paso2b_aperturas_SP26() { paso2b_aperturas("SP26"); }
function paso2b_aperturas_force_SP26() { paso2b_aperturas_force("SP26"); }


// ── Cambios por período — confirmados por Carlos ──────────────
//
// PATRÓN DE NOMENCLATURA:
//   paso2b_cambios_{COHORT}_{MOMENT}()
//
// INSTRUCCIÓN PARA NUEVOS PERÍODOS:
//   Cuando Carlos confirme cambios para un período nuevo, crear una
//   función nueva con el nombre del cohorte y momento correspondiente.
//   Documentar cada cambio con la fecha de confirmación de Carlos.
//   Nunca modificar una función de cambios ya ejecutada — crear una nueva.
//
// IMPORTANTE — ORDEN DE EJECUCIÓN:
//   1. paso2b_aperturas_{COHORT}()         ← primero: carga el plan base
//   2. paso2b_cambios_{COHORT}_{MOMENT}()  ← segundo: aplica los cambios
//   3. paso2b_diagnostico()                ← tercero: verificar resultado

/**
 * Cambios de Carlos para MR26 · C1M2 (confirmados 17-mar-2026).
 *
 * RESUMEN DE CAMBIOS:
 *   TLC — Cancelación:
 *     FOT cancelada — TLC no abre en MR26/C1M2 por falta de estudiantes.
 *
 *   MKT — Reemplazos:
 *     CRC cancelada → SEM abre en su lugar
 *     MDA fuera de malla (estudiantes EN26 rezagados)
 *
 *   ADM — Reemplazos:
 *     HID cancelada → GDR abre en su lugar
 *     GEN fuera de malla (sin equivalente en malla oficial)
 *     RIN fuera de malla (sin equivalente en malla oficial)
 *
 *   SIS — Reemplazos:
 *     EXC cancelada → PAI abre en su lugar
 *     DPW fuera de malla (sin equivalente en malla oficial)
 *
 *   TRV — Nueva apertura compartida:
 *     TFG (Trabajo Final de Grado) — 1 aula para MKT + ADM + SIS
 *     Miércoles 6-7:30PM | Carlos Triviño
 *
 * Total aulas a CREAR: 12
 *   CTB/SPC, ADM/GDR, SIS/PAI, MKT/SEM, SST/FDR,
 *   TRV/MAT, TRV/HIA, TRV/TFG,
 *   ADM/GEN, ADM/RIN, SIS/DPW, MKT/MDA
 * Canceladas (auditoría): TLC/FOT, ADM/HID, MKT/CRC, SIS/EXC
 *
 * PREREQUISITO: paso2b_aperturas_MR26() ya ejecutado.
 * Re-ejecutar es seguro — gestionarApertura() es idempotente.
 */
function paso2b_cambios_MR26_C1M2() {
  Logger.log("▶ PASO 2b CAMBIOS: Aplicando cambios MR26 · C1M2...");
  Logger.log("   Fuente: confirmación de Carlos — 17-mar-2026");
  Logger.log("   Programas afectados: MKT, ADM, SIS, TLC");

  // ── TLC — Cambio 0: FOT cancelada por falta de estudiantes ────
  cancelar_(
    "MR26", "C1M2", "FOT", "TLC",
    "TLC no abre en MR26/C1M2 — sin estudiantes inscritos. Confirmado Carlos 17-mar-2026"
  );

  // ── MKT — Cambio 1: CRC cancelada → SEM ───────────────────────
  reemplazar_(
    "MR26", "C1M2", "MKT",
    "CRC",  // cancela
    "SEM",  // abre
    false,
    "Carlos 17-mar-2026: SEM reemplaza CRC en MKT"
  );

  // ── MKT — Cambio 2: MDA fuera de malla ────────────────────────
  agregar_(
    "MR26", "C1M2", "MDA", "MKT", false,
    "Fuera de malla — estudiantes MKT de EN26 rezagados. Aprobado Carlos 17-mar-2026"
  );

  // ── ADM — Cambio 3: HID cancelada → GDR ───────────────────────
  reemplazar_(
    "MR26", "C1M2", "ADM",
    "HID",  // cancela
    "GDR",  // abre
    false,
    "Carlos 17-mar-2026: GDR reemplaza HID en ADM"
  );

  // ── ADM — Cambio 4: GEN fuera de malla ────────────────────────
  agregar_(
    "MR26", "C1M2", "GEN", "ADM", false,
    "Fuera de malla — sin equivalente en malla oficial ADM. Aprobado Carlos 17-mar-2026"
  );

  // ── ADM — Cambio 5: RIN fuera de malla ────────────────────────
  agregar_(
    "MR26", "C1M2", "RIN", "ADM", false,
    "Fuera de malla — sin equivalente en malla oficial ADM. Aprobado Carlos 17-mar-2026"
  );

  // ── SIS — Cambio 6: EXC cancelada → PAI ───────────────────────
  reemplazar_(
    "MR26", "C1M2", "SIS",
    "EXC",  // cancela
    "PAI",  // abre
    false,
    "Carlos 17-mar-2026: PAI reemplaza EXC en SIS"
  );

  // ── SIS — Cambio 7: DPW fuera de malla ────────────────────────
  agregar_(
    "MR26", "C1M2", "DPW", "SIS", false,
    "Fuera de malla — sin equivalente en malla oficial SIS. Aprobado Carlos 17-mar-2026"
  );

  // ── TRV — TFG (Trabajo Final de Grado) — aula compartida ──────
  // Una sola aula para MKT + ADM + SIS (mismo horario: Miércoles 6-7:30PM).
  // Carlos Triviño dicta los 3 programas. isTransversal=true → una sola aula TRV.
  // Confirmado en horario oficial 17-mar-2026.
  agregar_(
    "MR26", "C1M2", "TFG", "TRV", true,
    "Trabajo Final de Grado — 1 aula compartida MKT+ADM+SIS. Docente: Carlos Triviño. " +
    "Mi\u00e9rcoles 6-7:30PM. Confirmado Carlos 17-mar-2026"
  );

  // Verificar resultado final
  Logger.log("\n▶ Estado de APERTURA_PLAN tras los 9 cambios:");
  diagnosticoAperturas();
}


// ─────────────────────────────────────────────────────────────
// DIAGNÓSTICO — estado actual del ecosistema
// ─────────────────────────────────────────────────────────────

/**
 * Lee el estado actual de los 3 Spreadsheets sin modificar nada.
 * Útil para verificar que todo está en orden antes de ejecutar
 * pasos siguientes o para debug después de un error.
 * Usa getRootFolderSafe() con cache de ScriptProperties —
 * más rápido que DriveApp.getFoldersByName() en cada llamada.
 */
function diagnosticoSistema() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔍 SIDEP — Diagnóstico del sistema");
  Logger.log("   " + Utilities.formatDate(nowSIDEP(), "America/Bogota", "yyyy-MM-dd HH:mm:ss"));
  Logger.log("════════════════════════════════════════════════");

  // 1. Verificar carpeta raíz vía cache de ScriptProperties
  var rootExists = false;
  try {
    getRootFolderSafe(); // lanza si no existe ni en cache ni en Drive
    rootExists = true;
  } catch (e) {
    rootExists = false;
  }
  Logger.log("\n📁 CARPETAS DRIVE:");
  Logger.log("   Raíz '" + SIDEP_CONFIG.rootFolderName + "': " + (rootExists ? "✅ Existe" : "❌ No existe"));

  if (!rootExists) {
    Logger.log("\n⛔ El ecosistema no ha sido inicializado.");
    Logger.log("   → Ejecutar onboardingCompleto() para comenzar.");
    return;
  }

  // 2. Verificar Spreadsheets
  Logger.log("\n📊 SPREADSHEETS:");
  var fileKeys = ["core", "admin", "bi"];
  var ssMap    = {};
  fileKeys.forEach(function(key) {
    try {
      var ss = getSpreadsheetByName(key);
      var hojas = ss.getSheets().length;
      Logger.log("   ✅ " + SIDEP_CONFIG.files[key] + " → " + hojas + " hojas");
      ssMap[key] = ss;
    } catch (e) {
      Logger.log("   ❌ " + SIDEP_CONFIG.files[key] + " → NO ENCONTRADO");
      ssMap[key] = null;
    }
  });

  // 3. Verificar tablas clave y conteo de filas
  Logger.log("\n📋 TABLAS CLAVE (filas de datos, sin encabezado):");

  var tablasVerificar = [
    { key: "core",  nombre: "_CFG_STATUSES"      },
    { key: "core",  nombre: "_CFG_SUBJECTS"       },
    { key: "core",  nombre: "_CFG_COHORT_CALENDAR"},
    { key: "core",  nombre: "_SYS_VERSION"        },
    { key: "core",  nombre: "APERTURA_PLAN"       },
    { key: "core",  nombre: "MasterDeployments"   },
    { key: "core",  nombre: "DeploymentTopics"    },
    { key: "admin", nombre: "_CFG_SYLLABUS"       },
    { key: "admin", nombre: "Students"            },
    { key: "admin", nombre: "Enrollments"         },
    { key: "admin", nombre: "Teachers"            },
    { key: "admin", nombre: "RiskFlags"           }
  ];

  tablasVerificar.forEach(function(t) {
    var ss = ssMap[t.key];
    if (!ss) {
      Logger.log("   ⚠️  " + t.nombre + " → SS no disponible");
      return;
    }
    var hoja = ss.getSheetByName(t.nombre);
    if (!hoja) {
      Logger.log("   ❌ " + t.nombre + " → NO EXISTE (ejecutar setupSidepTables)");
      return;
    }
    var filas = Math.max(0, hoja.getLastRow() - 1);
    var estado = filas > 0 ? "✅" : "⬜";
    Logger.log("   " + estado + " " + t.nombre + " → " + filas + " registros");
  });

  // 4. Resumen de qué falta
  Logger.log("\n📌 RESUMEN:");
  var coreSS = ssMap["core"];
  if (coreSS) {
    var verHoja   = coreSS.getSheetByName("_SYS_VERSION");
    var ultimaVer = verHoja && verHoja.getLastRow() > 1
      ? verHoja.getRange(verHoja.getLastRow(), 2).getValue()
      : "No registrada";
    Logger.log("   Última versión: " + ultimaVer);

    // FIX-AUDIT M-3: incluir APERTURA_PLAN en diagnóstico (tabla base del pipeline v4.0)
    var hojaApr = coreSS.getSheetByName("APERTURA_PLAN");
    if (hojaApr && hojaApr.getLastRow() > 1) {
      var aprData = hojaApr.getRange(2, 1, hojaApr.getLastRow() - 1,
                                    hojaApr.getLastColumn()).getValues();
      var cntAPend = 0, cntACreada = 0, cntACancel = 0;
      // AperturaStatus está en la columna índice 6 (COL_APR.AperturaStatus)
      aprData.forEach(function(r) {
        var s = String(r[6] || "");
        if (s === "PENDIENTE")  cntAPend++;
        else if (s === "CREADA")    cntACreada++;
        else if (s === "CANCELADA") cntACancel++;
      });
      Logger.log("   APERTURA_PLAN  : " + aprData.length + " filas → " +
                 cntAPend + " PENDIENTE · " + cntACreada + " CREADA · " + cntACancel + " CANCELADA");
    } else {
      Logger.log("   APERTURA_PLAN  : ⬜ Vacía → ejecutar paso2b_aperturas_{COHORT}()");
    }
  }

  var adminSS    = ssMap["admin"];
  var syllabus   = adminSS ? adminSS.getSheetByName("_CFG_SYLLABUS") : null;
  var sylRows    = syllabus ? Math.max(0, syllabus.getLastRow() - 1) : 0;
  var cfgStatus  = coreSS ? coreSS.getSheetByName("_CFG_STATUSES") : null;
  var statusRows = cfgStatus ? Math.max(0, cfgStatus.getLastRow() - 1) : 0;

  Logger.log("   Catálogos _CFG_*: " + (statusRows > 0 ? "✅ Poblados" : "⬜ Vacíos → ejecutar paso2_configuraciones()"));
  Logger.log("   Syllabus: "         + (sylRows > 0   ? "✅ " + sylRows + " semanas" : "⬜ Vacío → ejecutar paso3_syllabus()"));

  Logger.log("\n════════════════════════════════════════════════");
}


// ─────────────────────────────────────────────────────────────
// PASO 4 — Aulas Classroom
// PREREQUISITO: Classroom API habilitada como servicio avanzado en GAS.
//   Editor → ➕ Servicios → Google Classroom API → Agregar
// PREREQUISITO: Carlos confirma que docentes están listos.
// PREREQUISITO: paso2b completo (aperturas base + cambios de Carlos).
//
// FLUJO COMPLETO POR PERÍODO (en orden):
//   1. paso2b_aperturas_MR26()         → plan base (malla oficial)
//   2. paso2b_cambios_MR26_C1M2()      → cambios que Carlos confirmó
//   3. paso2b_diagnostico()            → verificar PENDIENTE/CANCELADA
//   4. paso4_dryRun_MR26_C1M2()        → preview sin tocar Classroom
//   5. paso4_planificarYCrear_MR26_C1M2() → ejecutar (PENDING → CREATED)
//   6. paso4_diagnostico()             → verificar CREATED
//   7. paso5_estructurar_MR26()        → crear Topics en cada aula
// ─────────────────────────────────────────────────────────────

// ── Funciones genéricas (parametrizadas) ─────────────────────

/**
 * Preview: muestra qué se crearía para la ventana y momento dados, sin escribir nada.
 * Lee APERTURA_PLAN (Status=PENDIENTE). Si está vacío, indica que hay que
 * ejecutar poblarAperturas({ cohortCode }) primero.
 */
function paso4_dryRun(cohortCode, momentCode) {
  planificarDesdeAperturaPlan({ cohortCode: cohortCode, momentCode: momentCode, dryRun: true });
}

/**
 * Genera filas PENDING en MasterDeployments leyendo APERTURA_PLAN.
 * Actualiza APERTURA_PLAN: AperturaStatus PENDIENTE → CREADA.
 * No llama Classroom API.
 */
function paso4_planificar(cohortCode, momentCode) {
  planificarDesdeAperturaPlan({ cohortCode: cohortCode, momentCode: momentCode });
}

/** Planifica Y crea aulas para una ventana y momento en una sola ejecución. */
function paso4_planificarYCrear(cohortCode, momentCode) {
  planificarYCrear({ cohortCode: cohortCode, momentCode: momentCode });
}

/** Procesa el siguiente batch de PENDING para la ventana dada (hasta batchSize=20). */
function paso4_crearAulas(cohortCode) {
  crearAulas({ cohortCode: cohortCode });
}

/** Estado actual de MasterDeployments: PENDING/CREATED/ERROR por programa, momento y ventana. */
function paso4_diagnostico() {
  diagnosticoAulas();
}

// ── Atajos por ventana 2026 ───────────────────────────────────
// Invocar desde el editor sin tener que recordar cohortCode/momentCode.
// Secuencia correcta por ventana: dryRun → planificar → crearAulas → diagnostico.

/** EN26 abre C1M1 — primera ventana del año. */
function paso4_dryRun_EN26_C1M1()          { paso4_dryRun("EN26", "C1M1");          }
function paso4_planificarYCrear_EN26_C1M1() { paso4_planificarYCrear("EN26", "C1M1"); }
function paso4_crearAulas_EN26()            { paso4_crearAulas("EN26");               }

/** MR26 abre C1M2 — ventana marzo. */
function paso4_dryRun_MR26_C1M2()          { paso4_dryRun("MR26", "C1M2");          }
function paso4_planificarYCrear_MR26_C1M2() { paso4_planificarYCrear("MR26", "C1M2"); }
function paso4_crearAulas_MR26()            { paso4_crearAulas("MR26");               }

/** MY26 abre C2M1 — ventana mayo (abre 19-may-2026). */
function paso4_dryRun_MY26_C2M1()          { paso4_dryRun("MY26", "C2M1");          }
function paso4_planificarYCrear_MY26_C2M1() { paso4_planificarYCrear("MY26", "C2M1"); }
function paso4_crearAulas_MY26()            { paso4_crearAulas("MY26");               }

/** AG26 abre C2M2 — ventana agosto (abre 4-ago-2026). */
function paso4_dryRun_AG26_C2M2()          { paso4_dryRun("AG26", "C2M2");          }
function paso4_planificarYCrear_AG26_C2M2() { paso4_planificarYCrear("AG26", "C2M2"); }
function paso4_crearAulas_AG26()            { paso4_crearAulas("AG26");               }

/** SP26 abre C1M1 — ventana septiembre (abre 29-sep-2026). */
function paso4_dryRun_SP26_C1M1()          { paso4_dryRun("SP26", "C1M1");          }
function paso4_planificarYCrear_SP26_C1M1() { paso4_planificarYCrear("SP26", "C1M1"); }
function paso4_crearAulas_SP26()            { paso4_crearAulas("SP26");               }


// ─────────────────────────────────────────────────────────────
// PASO 5 — Estructura de aulas (Topics por semana)
// PREREQUISITO: paso 4 completado (aulas CREATED en MasterDeployments).
// PREREQUISITO: poblarSyllabus() ejecutado (_CFG_SYLLABUS en ADMIN poblada).
// Ejecutar en múltiples corridas (batchSize=20 por defecto).
// ─────────────────────────────────────────────────────────────

/** Crea topics para el siguiente batch de aulas CREATED sin estructura. */
function paso5_estructurar(cohortCode) {
  estructurarAulas({ cohortCode: cohortCode });
}

/** Estado actual de DeploymentTopics: TOPICS_CREATED/STRUCTURE_ERROR/progreso. */
function paso5_diagnostico() {
  diagnosticoEstructura();
}

// ── Atajos por ventana 2026 ───────────────────────────────────

function paso5_estructurar_EN26() { paso5_estructurar("EN26"); }
function paso5_estructurar_MR26() { paso5_estructurar("MR26"); }
function paso5_estructurar_MY26() { paso5_estructurar("MY26"); }
function paso5_estructurar_AG26() { paso5_estructurar("AG26"); }
function paso5_estructurar_SP26() { paso5_estructurar("SP26"); }


// ─────────────────────────────────────────────────────────────
// PASO 6 — Importar docentes
// PREREQUISITO: paso 4 completado (aulas CREATED).
// PREREQUISITO: DOCENTES_DATA y ASIGNACIONES_DATA actualizadas
//   en 06_importarDocentes.gs con los cambios del período.
// ─────────────────────────────────────────────────────────────

/**
 * Envía invitaciones de co-teacher a todos los docentes en ASIGNACIONES_DATA.
 * Escribe en TeacherAssignments: InvitationID + InvitationStatus=TEACHER_INVITED.
 * IsActive = false hasta que el docente acepte.
 * Re-ejecutar es seguro: 409 de Classroom = invitación ya enviada.
 */
function paso6_importarDocentes() {
  Logger.log("▶ PASO 6: Importando docentes y enviando invitaciones...");
  importarDocentes();
}

/** Estado actual de invitaciones: cuántas TEACHER_INVITED/ACCEPTED/DECLINED. */
function paso6_diagnosticoInvitaciones() {
  diagnosticoInvitaciones();
}


// ─────────────────────────────────────────────────────────────
// PASO 6b — Sincronizar estado de invitaciones
// PREREQUISITO: paso 6 completado (hay filas TEACHER_INVITED en Sheets).
//
// FLUJO:
//   1. paso6b_instalarTrigger() — ejecutar UNA sola vez por período.
//      El trigger corre automáticamente a las 7 AM cada día.
//   2. paso6b_diagnosticoInvitaciones() — verificar progreso en cualquier momento.
//   3. paso6b_eliminarTrigger() — cuando ya no queden TEACHER_INVITED pendientes.
//
// También se puede ejecutar manualmente con paso6b_sincronizar() en cualquier
// momento, con o sin el trigger activo.
// ─────────────────────────────────────────────────────────────

/**
 * Verifica qué invitaciones fueron aceptadas/rechazadas en Classroom
 * y actualiza TeacherAssignments en batch.
 * Lógica: Invitations.get(id) → 404 = consumida → Teachers.get() → acepta/rechaza.
 */
function paso6b_sincronizar() {
  Logger.log("▶ PASO 6b: Sincronizando estado de invitaciones...");
  sincronizarInvitaciones();
}

/**
 * Preview de la sincronización — muestra qué cambiaría sin escribir nada.
 * Útil para verificar antes de ejecutar la sincronización real.
 */
function paso6b_sincronizarDryRun() {
  Logger.log("▶ PASO 6b DRY RUN: Preview de sincronización...");
  sincronizarInvitaciones({ dryRun: true });
}

/**
 * Instala el trigger automático diario a las 7 AM.
 * Ejecutar UNA sola vez después de paso6_importarDocentes().
 * El trigger corre sincronizarInvitaciones() todos los días hasta eliminarlo.
 */
function paso6b_instalarTrigger() {
  Logger.log("▶ PASO 6b: Instalando trigger diario de sincronización...");
  configurarTriggerDiario();
}

/**
 * Elimina el trigger automático.
 * Ejecutar cuando todos los docentes hayan aceptado (0 TEACHER_INVITED pendientes).
 */
function paso6b_eliminarTrigger() {
  Logger.log("▶ PASO 6b: Eliminando trigger diario...");
  eliminarTriggerDiario();
}


// ─────────────────────────────────────────────────────────────
// PASO 7 — Importar estudiantes
// PREREQUISITO: paso 4 completado (aulas CREATED).
// PREREQUISITO: ESTUDIANTES_DATA completada en 17_importarEstudiantes.gs.
//
// FLUJO:
//   1. Completar ESTUDIANTES_DATA en 17_importarEstudiantes.gs
//      con los datos recopilados de los estudiantes MR26.
//   2. paso7_importarEstudiantes() — registra en Sheets + envía invitaciones
//   3. paso7_diagnostico() — verificar Students y Enrollments
//   4. Los estudiantes deben ACEPTAR la invitación por email para
//      aparecer en el aula.
//
// FORMATO DE CADA ENTRADA EN ESTUDIANTES_DATA:
//   ["Nombres", "Apellidos", "email@gmail.com", "CC", "NumDoc",
//    "PROG", "CohortEntrada", "DIRECTO", ["MAT1", "MAT2", ...]]
//
//   CohortEntrada: "MR26" = nuevo | "EN26" = antiguo avanzando
//   SubjectCodes: lista EXPLÍCITA de materias que cursa este período.
// ─────────────────────────────────────────────────────────────

/**
 * Registra estudiantes en Students + Enrollments y envía invitaciones
 * a Classroom. Re-ejecutar es seguro (409 = ya invitado).
 */
function paso7_importarEstudiantes() {
  Logger.log("▶ PASO 7: Importando estudiantes...");
  importarEstudiantes();
}

/** Registra matrículas en Enrollments SIN Classroom API.
 *  Usar cuando Invitations API falla por restricción de dominio.
 *  Prerequisito: paso7_importarEstudiantes() ya corrió (Students poblada). */
function paso7_registrarEnrollments() {
  Logger.log("▶ PASO 7b: Registrando matrículas en Enrollments (sin Classroom API)...");
  registrarEnrollments();
}

/** Estado actual de Students y Enrollments. */
function paso7_diagnostico() {
  diagnosticoEstudiantes();
}

// ─────────────────────────────────────────────────────────────
// PASO 8 — Notificar estudiantes (links de acceso a aulas)
// PREREQUISITO: paso7_importarEstudiantes() ejecutado.
// PREREQUISITO: Aulas CREATED con ClassroomID en MasterDeployments.
//
// FLUJO:
//   1. paso8_dryRun()    → preview en Logger, no envía nada
//   2. paso8_notificar() → envía 1 email por estudiante con sus links
//   3. Si alguien no recibió el email: paso8_reenviar('email@gmail.com')
//
// ALTERNATIVA A Invitations API (que requiere dominio confiable):
//   Usa enrollmentCode de Classroom para generar links públicos que
//   funcionan con cualquier cuenta Gmail sin restricciones de dominio.
// ─────────────────────────────────────────────────────────────

/** Preview de emails en Logger — no envía nada. */
function paso8_dryRun() {
  Logger.log("▶ PASO 8 DRY RUN: Preview de notificaciones...");
  notificarEstudiantes({ dryRun: true });
}

/** Envía un email personalizado a cada estudiante con sus join links. */
function paso8_notificar() {
  Logger.log("▶ PASO 8: Enviando notificaciones a estudiantes...");
  notificarEstudiantes();
}

/**
 * Reenvía el email a un estudiante específico.
 * Uso: cambiar el email en el código y ejecutar esta función.
 * O llamar directamente: notificarEstudiante_individual('email@gmail.com')
 */
function paso8_reenviar() {
  // ► Cambiar el email antes de ejecutar:
  var emailDestino = "email@gmail.com";
  Logger.log("▶ PASO 8 REENVÍO: Enviando a " + emailDestino + "...");
  notificarEstudiante_individual(emailDestino);
}