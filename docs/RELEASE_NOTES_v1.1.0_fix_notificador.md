# Release Notes — Fix Notificador Cruzado entre Cohortes (v1.1.0)

**Fecha:** 2026-05-18  
**Prioridad:** CRITICA — aplicar antes de procesar STG_MATRICULAS de MY26 (19-may-2026)  
**Autor:** Stevens Contreras

---

## Resumen ejecutivo

Se corrige el bug que hubiera causado que los correos de bienvenida a estudiantes MY26
incluyeran también las aulas MR26 (aún marcadas como ACTIVE). Se introduce el estado
`IN_GRADING` para separar formalmente el cierre académico (último día de clases) del
cierre administrativo (cuando el docente carga la nota final).

---

## Bug: descripción y reproducción

**Archivo:** `18b_notificarEstudiantes.js` → `_agruparPorEstudiante_()`

**Causa raíz:** La función filtraba Enrollments únicamente por `EnrollmentStatusCode === 'ACTIVE'`
sin ningún filtro por ventana (`WindowCohortCode`) o momento (`MomentCode`). Durante la semana
de transición MR26→MY26 (19-29 may-2026):

- Las matrículas MR26 siguen `ACTIVE` (esperando nota final del docente)
- Las matrículas MY26 recién creadas también son `ACTIVE`

Resultado: un solo correo confuso con aulas de ambas ventanas mezcladas.

**Bug secundario:** El campo "Ventana activa" en el correo HTML se asignaba a la *primera*
matrícula en la iteración. Si había matrículas de dos ventanas, el header mostraba MR26 o
MY26 arbitrariamente según el orden de filas en Enrollments.

---

## Solución: cambios por archivo

| Archivo | Versión | Cambio |
|---|---|---|
| `12_poblarConfiguraciones.js` | v2.1 → v2.2 | Agrega `IN_GRADING` a `poblarStatuses_()` y nueva función `registrarEstadoInGrading()` para UPSERT en instalaciones existentes |
| `18b_notificarEstudiantes.js` | v1.0 → v1.1 | Filtros opcionales `windowCohortCode`, `momentCode`, `enrollmentIds`; fix acumulación de ventanas en el correo |
| `43_job_procesarStgEstudiantes.js` | v1.0 → v1.1 | Auto-detección de combos (ventana/momento) del lote para notificar filtrado |
| `53_menu_staging_estudiantes.js` | v1.0 → v1.1 | 5 nuevas opciones de menú (notificación por ventana, cierre de cohorte) |
| `54_cerrarCohorteAcademico.js` | NUEVO v1.0 | `cerrarCohorteAcademico()`, `reabrirCohorteAcademico()`, `diagnosticoCierreCohorte()` |

---

## Procedimiento operativo para la semana 19-29 may-2026

### 1. Aplicar el patch (hacer UNA SOLA VEZ)

1. Copiar todos los archivos `.js` modificados al editor de Apps Script.
2. Ejecutar `registrarEstadoInGrading()` en el editor → confirmar que `IN_GRADING` aparece en `_CFG_STATUSES`.
3. Verificar el menú `SIDEP Estudiantes` en SIDEP_STG_ESTUDIANTES: debe mostrar las 3 opciones nuevas de Cierre de Cohorte.

### 2. El 19-may-2026 AM: cerrar MR26 académicamente

```
// En el editor de Apps Script — antes de procesar STG_MATRICULAS de MY26
diagnosticoCierreCohorte('MR26')   // anotar conteos
cerrarCohorteAcademico('MR26', { dryRun: true })   // revisar preview
cerrarCohorteAcademico('MR26')     // ejecutar real
diagnosticoCierreCohorte('MR26')   // verificar: ACTIVE=0, IN_GRADING=N
```

O desde el menú: `SIDEP Estudiantes → Cerrar cohorte para estudiantes...`

### 3. El 19-may-2026 AM: procesar STG_MATRICULAS de MY26

```
procesarStgMatriculas()
```

El sistema detecta automáticamente que el lote es MY26/C2M1 y notifica SOLO esas
matrículas. Las MR26 ya están en `IN_GRADING` y no interfieren.

### 4. Del 19 al 29-may: docentes cargan notas en Classroom MR26

Las aulas Classroom siguen abiertas (estado `CREATED`). Los docentes acceden normalmente.
El semáforo y el panel académico excluyen automáticamente las MR26 (filtran por ACTIVE).

### 5. El 29-may-2026: cierre administrativo MR26

*(Script futuro)* Leer notas finales de GradeAudit y marcar `IN_GRADING → COMPLETED/FAILED`.

---

## Procedimiento para futuras transiciones de cohorte

Cada vez que una ventana termine clases y la siguiente comience:

1. `cerrarCohorteAcademico('WINDOW_ANTERIOR')` — antes de procesar STG_MATRICULAS nuevo
2. `procesarStgMatriculas()` — procesa e notifica solo la ventana nueva
3. Docentes cargan notas durante ~1 semana
4. *(Futuro)* Cierre administrativo con notas finales

---

## Cómo hacer rollback si algo sale mal

### Rollback del cierre académico (antes de 29-may)

```javascript
reabrirCohorteAcademico('MR26')
// O desde el menú: SIDEP Estudiantes → Reabrir cohorte academico (rollback)...
```

Esto revierte `IN_GRADING → ACTIVE` para todas las matrículas MR26.

### Rollback de la notificación (si se enviaron correos incorrectos)

No hay rollback de emails ya enviados. Si se envió un correo con aulas mezcladas,
informar manualmente a los estudiantes.

---

## Archivos modificados

| Archivo | Versión vieja | Versión nueva | Backup |
|---|---|---|---|
| `12_poblarConfiguraciones.js` | v2.1 | v2.2 | `*.backup_20260518` |
| `18b_notificarEstudiantes.js` | v1.0 | v1.1 | `*.backup_20260518` |
| `43_job_procesarStgEstudiantes.js` | v1.0 | v1.1 | `*.backup_20260518` |
| `53_menu_staging_estudiantes.js` | v1.0 | v1.1 | `*.backup_20260518` |

## Archivos NO tocados (con razón)

| Archivo | Razón |
|---|---|
| `08_notificarEstudiantes.gs` | Deprecated — histórico de referencia |
| `20_semaforo.js` | Ya filtra por `status === 'ACTIVE'` — IN_GRADING queda fuera automáticamente |
| `21_panelAcademico.js` | Ídem — ya filtra por ACTIVE correctamente |
| `01_setupSidepTables.gs` | No se modificó el schema de Enrollments — solo se agrega un estado |
