# DEC-2026-015 — Separación de cierre académico vs administrativo del cohorte

**Fecha:** 2026-05-18  
**Estado:** VIGENTE  
**Tipo:** ARQUITECTURA  
**Autor:** Stevens Contreras

---

## Contexto

En SIDEP, cuando un cohorte termina sus clases, el sistema necesita:

1. **Cierre académico** — el estudiante ya no asiste a clases. Ocurre el último día de la ventana.
2. **Cierre administrativo** — el cohorte queda archivado con notas finales. Ocurre ~1 semana después, cuando los docentes terminan de cargar calificaciones en Classroom.

Antes de esta decisión, el modelo colapsaba ambos eventos en un único estado `ACTIVE → COMPLETED/FAILED`.
Esto funciona cuando los dos eventos ocurren simultáneamente, pero falla durante la semana de transición
entre cohortes (ej. MR26 termina clases el 19-may pero las notas no cierran hasta el 29-may).

**Síntoma visible:** Al procesar STG_MATRICULAS de MY26 el 19-may, `notificarEstudiantes()` 
hubiera incluido las aulas MR26 (aún ACTIVE) en el mismo correo que las aulas MY26.

---

## Decisión

Introducir el estado de matrícula `IN_GRADING` en `_CFG_STATUSES` (StatusType=ENROLLMENT):

```
ACTIVE → IN_GRADING → COMPLETED | FAILED
           ^
           |
    cierre academico          cierre administrativo
  (ultimo dia de clases)    (docente carga nota final)
```

**Semántica de IN_GRADING:**

- El estudiante terminó de asistir a clases.
- El aula Classroom sigue abierta para que el docente cargue la nota.
- El estudiante no está activamente cursando, pero tampoco tiene nota final aún.
- No se le envían notificaciones de nuevas matrículas.
- No se recalcula su riesgo académico (semáforo excluye IN_GRADING por diseño).

---

## Alternativas consideradas y descartadas

**Alternativa A: Filtrar notificador por ventana hardcodeada**  
Habría replicado el problema de la versión antigua `08_notificarEstudiantes.gs` que tenía
`WINDOW_COHORT_MR26` hardcodeado. No es estructural — solo pospone el problema.

**Alternativa B: Filtrar por fecha de fin de calendario**  
Depende de que `_CFG_COHORT_CALENDAR.EndDate` esté siempre actualizado y sincronizado.
Introduce dependencia implícita de datos. Frágil.

**Alternativa C: Agregar campo booleano `IsAcademicallyClosed` a Enrollments**  
Requiere migración de schema. Más complejo que agregar un estado al catálogo existente.

**Decisión final: IN_GRADING** — usa el mecanismo de estados existente, es explícito,
auditable en el log y no requiere cambios de schema en Enrollments.

---

## Impacto en componentes del ecosistema

| Componente | Impacto | Razón |
|---|---|---|
| `20_semaforo.js` | Sin cambios — compatible | Filtra por `status === 'ACTIVE'`. IN_GRADING queda fuera automáticamente. |
| `21_panelAcademico.js` | Sin cambios — compatible | Ídem. Panel ya no muestra MR26 como "en curso" — correcto. |
| `18b_notificarEstudiantes.js` | Modificado | Agrega filtros de defensa; acumula ventanas correctamente. |
| `43_job_procesarStgEstudiantes.js` | Modificado | Auto-detección de ventana del lote para notificar filtrado. |
| `53_menu_staging_estudiantes.js` | Modificado | Nuevas opciones de menú para gestión del estado. |
| `54_cerrarCohorteAcademico.js` | NUEVO | Implementa la transición ACTIVE → IN_GRADING de forma controlada. |
| `12_poblarConfiguraciones.js` | Modificado | Agrega IN_GRADING al catálogo de estados de matrícula. |
| AppSheet | Ninguno inmediato | Valid_If sobre `_CFG_STATUSES WHERE StatusType='ENROLLMENT'` incluirá IN_GRADING automáticamente en dropdowns. |

---

## Cómo se aplica

### Operación manual (coordinador)

```
1. SIDEP Estudiantes → Cerrar cohorte para estudiantes...
2. Ingresar código de ventana (ej. MR26)
3. Revisar dry-run en Logger
4. Confirmar cierre
```

### Operación programática

```javascript
// Verificar estado antes
diagnosticoCierreCohorte('MR26');

// Cerrar (con dry-run automático en el menú)
cerrarCohorteAcademico('MR26');

// Rollback si fue un error
reabrirCohorteAcademico('MR26');
```

### Integración con el flujo de notificación

`procesarStgMatriculas()` detecta automáticamente la ventana del lote y llama
`notificarEstudiantes({ windowCohortCode, momentCode })`. Si MR26 ya está en IN_GRADING
cuando se procesa MY26, las MR26 no aparecen en los correos de bienvenida MY26.

---

## Anti-patrones a evitar

- **No** cerrar académicamente una ventana si los docentes aún no han tenido acceso a
  Classroom para revisar asistencia. IN_GRADING no cierra el aula — pero el coordinador
  debe asegurarse de que el docente tiene el período completo para cargar notas.

- **No** hacer `reabrirCohorteAcademico()` después de que el docente ya cargó notas y el
  sistema procesó el cierre administrativo (COMPLETED/FAILED). `reabrirCohorteAcademico()`
  solo opera sobre IN_GRADING, nunca sobre COMPLETED/FAILED.

- **No** saltar el dry-run en `cerrarCohorteAcademico()`. El menú lo ejecuta
  automáticamente, pero si se llama directo desde el editor, usar `{ dryRun: true }` primero.

- **No** cerrar administrativamente (marcar COMPLETED/FAILED) sin antes verificar que
  las notas en GradeAudit son definitivas. El cierre administrativo es irreversible.
