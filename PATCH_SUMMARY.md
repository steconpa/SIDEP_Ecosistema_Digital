# Patch SIDEP-FIX-001 — Resumen Final

**Fecha:** 2026-05-18  
**Urgencia:** Aplicar antes del 19-may-2026 7:00 AM (antes de procesar STG_MATRICULAS de MY26)

---

## Archivos modificados

| Archivo | Cambio principal |
|---|---|
| `12_poblarConfiguraciones.js` | Agrega `IN_GRADING` a `poblarStatuses_()`. Nueva función `registrarEstadoInGrading()` para UPSERT en instalaciones existentes. |
| `18b_notificarEstudiantes.js` | Filtros opcionales por ventana/momento/enrollmentIds. Fix acumulación de ventanas en el header del correo. Retro-compatible v1.0.0. |
| `43_job_procesarStgEstudiantes.js` | Auto-detección de combos (ventana/momento) del lote. Notifica filtrado en lugar de notificar todo lo ACTIVE. |
| `53_menu_staging_estudiantes.js` | 5 opciones nuevas en el menú. Renombrado item "Notificar (enviar)" para claridad. |

## Archivos creados

| Archivo | Propósito |
|---|---|
| `54_cerrarCohorteAcademico.js` | `cerrarCohorteAcademico()`, `reabrirCohorteAcademico()`, `diagnosticoCierreCohorte()` |
| `docs/RELEASE_NOTES_v1.1.0_fix_notificador.md` | Notas de release con procedimiento operativo |
| `docs/DEC-2026-015_cierre_academico_vs_administrativo.md` | Decision log arquitectónica |

## Archivos NO tocados

| Archivo | Razón |
|---|---|
| `08_notificarEstudiantes.gs` | Deprecated — no tocar, sirve como referencia histórica |
| `20_semaforo.js` | Ya filtra por ACTIVE — IN_GRADING queda excluido automáticamente |
| `21_panelAcademico.js` | Ídem — comportamiento correcto sin cambios |

## Backups creados

- `12_poblarConfiguraciones.js.backup_20260518`
- `18b_notificarEstudiantes.js.backup_20260518`
- `43_job_procesarStgEstudiantes.js.backup_20260518`
- `53_menu_staging_estudiantes.js.backup_20260518`

---

## Instrucciones paso a paso para Stevens

### Paso 1: Subir archivos al editor de Apps Script

Copiar estos archivos al proyecto GAS (reemplazar los existentes):
1. `12_poblarConfiguraciones.js`
2. `18b_notificarEstudiantes.js`
3. `43_job_procesarStgEstudiantes.js`
4. `53_menu_staging_estudiantes.js`
5. `54_cerrarCohorteAcademico.js` (archivo NUEVO — agregar al proyecto)

### Paso 2: Registrar el estado IN_GRADING en _CFG_STATUSES

En el editor de Apps Script, ejecutar:
```javascript
registrarEstadoInGrading()
```

Verificar en `SIDEP_01_CORE_ACADEMICO → _CFG_STATUSES` que aparece:
- StatusCode: `IN_GRADING`
- StatusType: `ENROLLMENT`
- StatusLabel: `En calificacion`
- IsActive: `TRUE`

### Paso 3: Verificar el menú actualizado

Abrir `SIDEP_STG_ESTUDIANTES` → el menú `SIDEP Estudiantes` debe mostrar:
- `Notificar estudiantes por ventana...`
- `Notificar ultimo lote procesado`
- `Diagnostico de cierre por ventana...`
- `Cerrar cohorte para estudiantes...`
- `Reabrir cohorte academico (rollback)...`

### Paso 4: Diagnóstico MR26 antes del cierre

```javascript
diagnosticoCierreCohorte('MR26')
```
Anotar el número de matrículas ACTIVE.

### Paso 5: Cierre académico MR26 (19-may AM, antes de procesar MY26)

Desde el menú: `SIDEP Estudiantes → Cerrar cohorte para estudiantes...`  
O directo en el editor:
```javascript
cerrarCohorteAcademico('MR26', { dryRun: true })  // revisar preview
cerrarCohorteAcademico('MR26')                     // ejecutar real
diagnosticoCierreCohorte('MR26')                   // verificar: ACTIVE=0
```

### Paso 6: Procesar STG_MATRICULAS de MY26

```javascript
procesarStgMatriculas()
```

El sistema notificará automáticamente SOLO las matrículas MY26/C2M1.
Las MR26 ya están en IN_GRADING y no interferirán.

---

## Plan de pruebas T01-T08 — checklist

- [ ] **T01** — `notificarEstudiantes({ dryRun: true })` sin filtros: mismo conteo que antes del patch
- [ ] **T02** — `notificarEstudiantes({ dryRun: true, windowCohortCode: 'MR26' })`: solo aulas MR26
- [ ] **T03** — `cerrarCohorteAcademico('MR26', { dryRun: true })`: NO modifica Enrollments
- [ ] **T04** — Cierre real + rollback: `diagnosticoCierreCohorte` regresa a conteos iniciales
- [ ] **T05** — Re-ejecutar `cerrarCohorteAcademico('MR26')` en ventana ya cerrada: "Encontradas 0 matriculas"
- [ ] **T06** — Lote mixto (MR26+MY26 en STG): dos correos separados, no uno mezclado
- [ ] **T07** — Panel académico funciona sin errores después del cierre MR26
- [ ] **T08** — Semáforo corre sin errores; IN_GRADING excluido del conteo activo

---

## Cómo hacer rollback completo si algo sale mal

### Rollback del cierre académico

```javascript
reabrirCohorteAcademico('MR26')
// Verifica con:
diagnosticoCierreCohorte('MR26')  // debe mostrar ACTIVE=N original, IN_GRADING=0
```

### Rollback del patch de código

Los archivos `.backup_20260518` son copias exactas de los originales.  
Restaurar en el editor de Apps Script desde los backups.

### Rollback del estado IN_GRADING en _CFG_STATUSES

Si necesitas remover IN_GRADING: abrir `SIDEP_01_CORE_ACADEMICO → _CFG_STATUSES`,
borrar la fila con StatusCode=`IN_GRADING`. No afecta a ninguna otra tabla.

---

## Preguntas para Stevens

1. ¿El patch está listo para subir al editor de Apps Script?
2. ¿Necesitas que genere un script de migración para el primer cierre (cerrar MR26 el 19-may)?
3. ¿Quieres que actualice también el manual de coordinación con las opciones de menú nuevas?
